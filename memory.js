const fs = require('fs');
const v8 = require('v8');
const vm = require('vm');
const { execFileSync } = require('child_process');

// Memory watchdog. The Render instance has a 512Mi cgroup limit and the kernel
// kills the whole process (exit 137) the moment the container crosses it, which
// took the in-memory queue down mid-dataroom. Read the container's own
// accounting when there is one (cgroup v2, then v1); elsewhere (macOS, a bare
// VM) add up the RSS of this process and the Chrome tree it spawned and
// compare with MEMORY_LIMIT_MB.

const MB = 1024 * 1024;
const DEFAULT_LIMIT_MB = 512;
// Chrome's baseline plus a normal deck sits around 85-90% of the 512MB
// instance, so the watchdog only reacts at 95% and then first tries to shed
// memory (close spare tabs, purge the renderer's decoded-image cache, run
// Node's GC) and gives the usage MEMORY_PRESSURE_GRACE_MS to come back down
// before it gives the capture up. Usage that climbs past MEMORY_HARD_RATIO
// while waiting is aborted at once: the kernel kills the process at 100%.
const DEFAULT_PRESSURE_RATIO = 0.95;
const DEFAULT_GRACE_MS = 6000;
const DEFAULT_HARD_RATIO = 0.98;
const DEFAULT_POLL_MS = 2000;

const CGROUP_V2 = { usage: '/sys/fs/cgroup/memory.current', limit: '/sys/fs/cgroup/memory.max', stat: '/sys/fs/cgroup/memory.stat' };
const CGROUP_V1 = { usage: '/sys/fs/cgroup/memory/memory.usage_in_bytes', limit: '/sys/fs/cgroup/memory/memory.limit_in_bytes', stat: '/sys/fs/cgroup/memory/memory.stat' };
// cgroup v1 reports "no limit" as a huge number rather than "max".
const CGROUP_UNLIMITED = 2 ** 60;

function readFileNumber(path) {
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    if (raw === 'max') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

// memory.current/usage_in_bytes count the page cache too: Chromium's ~200MB
// of binaries and libraries sit there as clean file pages the kernel can drop
// at any time, and it does so long before it kills anything. What actually
// counts against the limit is what cannot be reclaimed: anonymous memory
// (heaps, decoded bitmaps), shared memory and kernel allocations. Read those
// from memory.stat; with an incomplete stat file fall back to usage minus
// inactive file pages (what `docker stats` shows); without a stat file use
// the raw figure.
function readStat(statPath) {
  const out = {};
  try {
    for (const line of fs.readFileSync(statPath, 'utf8').split('\n')) {
      const [key, value] = line.trim().split(/\s+/);
      const n = Number(value);
      if (key && Number.isFinite(n)) out[key] = n;
    }
  } catch (_) {}
  return out;
}

// Returns { bytes, breakdown } or null when the stat file has no usable keys.
function unreclaimableFromStat(stat) {
  const anon = stat.anon ?? stat.total_rss ?? stat.rss;
  if (!Number.isFinite(anon)) return null;
  const shmem = stat.shmem ?? stat.total_shmem ?? 0;
  // cgroup v2 kernels from 5.19 report a single "kernel" total; older ones
  // list the parts.
  const kernel = Number.isFinite(stat.kernel)
    ? stat.kernel
    : (stat.kernel_stack ?? 0) + (stat.slab_unreclaimable ?? 0) + (stat.sock ?? 0) + (stat.percpu ?? 0) + (stat.pagetables ?? 0);
  const file = stat.file ?? stat.total_cache ?? stat.cache ?? 0;
  return { bytes: anon + shmem + kernel, breakdown: { anon, shmem, kernel, file } };
}

function readInactiveFile(stat) {
  const n = stat.inactive_file ?? stat.total_inactive_file;
  return Number.isFinite(n) ? n : 0;
}

let lastBreakdown = null;

function detectSource() {
  if (process.platform === 'linux') {
    if (readFileNumber(CGROUP_V2.usage) !== null) return { kind: 'cgroup v2', files: CGROUP_V2 };
    if (readFileNumber(CGROUP_V1.usage) !== null) return { kind: 'cgroup v1', files: CGROUP_V1 };
  }
  return { kind: 'rss', files: null };
}

let source = null;
function getSource() {
  if (!source) source = detectSource();
  return source;
}

// RSS of this process plus every descendant (the Chrome tree puppeteer
// launched), from one `ps` call. Returns bytes.
function processTreeRss() {
  let table;
  try {
    table = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 5000 });
  } catch (_) {
    return process.memoryUsage().rss;
  }
  const children = new Map();
  const rss = new Map();
  for (const line of table.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const kb = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rss.set(pid, Number.isFinite(kb) ? kb * 1024 : 0);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  let total = 0;
  const stack = [process.pid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) || 0;
    for (const child of children.get(pid) || []) stack.push(child);
  }
  // ps may not list this process yet (or at all in some sandboxes).
  if (!rss.has(process.pid)) total += process.memoryUsage().rss;
  return total;
}

function usage() {
  const src = getSource();
  if (src.files) {
    const raw = readFileNumber(src.files.usage);
    if (raw !== null) {
      const stat = readStat(src.files.stat);
      const unreclaimable = unreclaimableFromStat(stat);
      if (unreclaimable) {
        lastBreakdown = { raw, ...unreclaimable.breakdown };
        return Math.min(raw, unreclaimable.bytes);
      }
      lastBreakdown = { raw, inactiveFile: readInactiveFile(stat) };
      return Math.max(0, raw - readInactiveFile(stat));
    }
  }
  lastBreakdown = null;
  return processTreeRss();
}

function envLimitBytes() {
  const mb = Number(process.env.MEMORY_LIMIT_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_LIMIT_MB) * MB;
}

function limit() {
  const src = getSource();
  if (src.files) {
    const n = readFileNumber(src.files.limit);
    if (n !== null && n > 0 && n < CGROUP_UNLIMITED) return n;
  }
  return envLimitBytes();
}

function pressureRatio() {
  const r = Number(process.env.MEMORY_PRESSURE_RATIO);
  return Number.isFinite(r) && r > 0 && r <= 1 ? r : DEFAULT_PRESSURE_RATIO;
}

function graceMs() {
  const n = Number(process.env.MEMORY_PRESSURE_GRACE_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_MS;
}

function hardRatio() {
  const r = Number(process.env.MEMORY_HARD_RATIO);
  return Number.isFinite(r) && r > 0 && r <= 1 ? r : DEFAULT_HARD_RATIO;
}

function sourceName() {
  return getSource().kind;
}

// Node's garbage collector, when it can be reached: global.gc exists when the
// process was started with --expose-gc (the start script does that); otherwise
// turn the flag on at runtime and fetch gc from a fresh context. Returns
// false when neither works.
let gcFn = null;
function forceGc() {
  if (!gcFn) {
    if (typeof global.gc === 'function') {
      gcFn = global.gc;
    } else {
      try {
        v8.setFlagsFromString('--expose-gc');
        const fn = vm.runInNewContext('gc');
        if (typeof fn === 'function') gcFn = fn;
      } catch (_) {
        gcFn = null;
      }
    }
  }
  if (!gcFn) return false;
  try {
    gcFn();
    return true;
  } catch (_) {
    return false;
  }
}

function formatMB(bytes) {
  return `${Math.round(bytes / MB)}MB`;
}

function describe() {
  const used = usage();
  const max = limit();
  let detail = sourceName();
  if (lastBreakdown && lastBreakdown.anon !== undefined) {
    detail += `; cgroup total ${formatMB(lastBreakdown.raw)} = anon ${formatMB(lastBreakdown.anon)} + file cache ${formatMB(lastBreakdown.file)} + shmem ${formatMB(lastBreakdown.shmem)} + kernel ${formatMB(lastBreakdown.kernel)}`;
  } else if (lastBreakdown) {
    detail += `; cgroup total ${formatMB(lastBreakdown.raw)} minus inactive file ${formatMB(lastBreakdown.inactiveFile)}`;
  }
  return `${formatMB(used)} of ${formatMB(max)} (${Math.round((used / max) * 100)}%, ${detail})`;
}

function logUsage(label) {
  console.log(`Memory ${label}: ${describe()}`);
}

/**
 * Poll usage every pollMs while a conversion runs. Two stages:
 *
 *  1. The first time usage crosses MEMORY_PRESSURE_RATIO of the limit, call
 *     onShed({ usage, limit, threshold, ratio }) (may be async: close spare
 *     tabs, recycle the viewer tab, run GC) and keep polling meanwhile.
 *  2. If usage is still above the threshold once MEMORY_PRESSURE_GRACE_MS have
 *     passed since the shed finished (or since it started, if it takes longer
 *     than MAX_SHED_MS), call onPressure({ usage, limit, ratio }) once. Usage
 *     above MEMORY_HARD_RATIO of the limit skips the wait.
 *
 * Usage that drops back under the threshold re-arms the first stage, so a later
 * climb sheds again. The handle's rearm() lets onPressure fire again (after the
 * shared browser has been relaunched and the memory is back), stop() ends the
 * polling.
 */
const MAX_SHED_MS = 60000;

function watch(onPressure, { onShed = null, pollMs = DEFAULT_POLL_MS, graceMs: grace = graceMs() } = {}) {
  const max = limit();
  const threshold = Math.floor(max * pressureRatio());
  const hardLimit = Math.floor(max * hardRatio());
  let tripped = false;
  let stopped = false;
  // The current excursion above the threshold: when the shed started and
  // finished (null while it runs).
  let excursion = null;

  const fire = (used, why) => {
    tripped = true;
    console.log(`Memory pressure: ${formatMB(used)} of ${formatMB(max)} (threshold ${formatMB(threshold)}, ${why}, ${sourceName()})`);
    try {
      onPressure({ usage: used, limit: max, ratio: used / max });
    } catch (e) {
      console.error('Memory pressure handler failed:', e);
    }
  };

  const startShed = (used) => {
    const ex = { startedAt: Date.now(), doneAt: null };
    excursion = ex;
    console.log(`Memory high: ${formatMB(used)} of ${formatMB(max)} (threshold ${formatMB(threshold)}, ${sourceName()}); shedding, then ${grace}ms to recover`);
    Promise.resolve()
      .then(() => (onShed ? onShed({ usage: used, limit: max, threshold, ratio: used / max }) : undefined))
      .catch(e => console.error('Memory shed handler failed:', e))
      .then(() => {
        ex.doneAt = Date.now();
        if (stopped || excursion !== ex) return;
        let after = null;
        try { after = usage(); } catch (_) {}
        if (after !== null) {
          console.log(`Memory after shedding: ${formatMB(after)} of ${formatMB(max)} (was ${formatMB(used)}, shed took ${Math.round((ex.doneAt - ex.startedAt) / 1000)}s)`);
        }
      });
  };

  const check = () => {
    if (stopped || tripped) return;
    let used;
    try {
      used = usage();
    } catch (e) {
      console.log('Memory watchdog read failed:', e.message);
      return;
    }
    if (used <= threshold) {
      if (excursion && excursion.doneAt !== null) {
        console.log(`Memory back under the threshold: ${formatMB(used)} of ${formatMB(max)}`);
        excursion = null;
      }
      // A shed still running is left to finish; its excursion ends when the
      // next reading is low too.
      return;
    }
    if (excursion === null) {
      startShed(used);
      return;
    }
    if (used > hardLimit) {
      fire(used, `above the hard limit ${formatMB(hardLimit)}`);
      return;
    }
    const now = Date.now();
    const graceFrom = excursion.doneAt !== null ? excursion.doneAt : excursion.startedAt + MAX_SHED_MS;
    if (now - graceFrom >= grace) {
      fire(used, `still high ${Math.round((now - excursion.startedAt) / 1000)}s after shedding began`);
    }
  };

  const timer = setInterval(check, pollMs);
  // Never keep the process alive just to poll.
  if (timer.unref) timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    rearm() {
      tripped = false;
      excursion = null;
    },
    check,
    get tripped() { return tripped; },
    threshold,
    hardLimit,
    graceMs: grace
  };
}

module.exports = { usage, limit, watch, logUsage, describe, formatMB, sourceName, pressureRatio, graceMs, hardRatio, forceGc, MB, readStat, unreclaimableFromStat, readInactiveFile };
