const fs = require('fs');
const { execFileSync } = require('child_process');

// Memory watchdog. The Render instance has a 512Mi cgroup limit and the kernel
// kills the whole process (exit 137) the moment the container crosses it, which
// took the in-memory queue down mid-dataroom. Read the container's own
// accounting when there is one (cgroup v2, then v1); elsewhere (macOS, a bare
// VM) add up the RSS of this process and the Chrome tree it spawned and
// compare with MEMORY_LIMIT_MB.

const MB = 1024 * 1024;
const DEFAULT_LIMIT_MB = 512;
const DEFAULT_PRESSURE_RATIO = 0.85;
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

// memory.current/usage_in_bytes count the page cache too; the kernel drops
// inactive file pages before it kills anything, so subtract them the way
// `docker stats` does. Without the stat file the raw figure is used.
function readInactiveFile(statPath) {
  try {
    const stat = fs.readFileSync(statPath, 'utf8');
    const line = stat.split('\n').find(l => l.startsWith('inactive_file ') || l.startsWith('total_inactive_file '));
    if (!line) return 0;
    const n = Number(line.split(/\s+/)[1]);
    return Number.isFinite(n) ? n : 0;
  } catch (_) {
    return 0;
  }
}

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
    if (raw !== null) return Math.max(0, raw - readInactiveFile(src.files.stat));
  }
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

function sourceName() {
  return getSource().kind;
}

function formatMB(bytes) {
  return `${Math.round(bytes / MB)}MB`;
}

function describe() {
  const used = usage();
  const max = limit();
  return `${formatMB(used)} of ${formatMB(max)} (${Math.round((used / max) * 100)}%, ${sourceName()})`;
}

function logUsage(label) {
  console.log(`Memory ${label}: ${describe()}`);
}

/**
 * Poll usage every pollMs while a conversion runs and call onPressure({ usage,
 * limit, ratio }) once when usage crosses MEMORY_PRESSURE_RATIO of the limit.
 * The handle's rearm() lets it fire again (after the shared browser has been
 * relaunched and the memory is back), stop() ends the polling.
 */
function watch(onPressure, { pollMs = DEFAULT_POLL_MS } = {}) {
  const max = limit();
  const threshold = Math.floor(max * pressureRatio());
  let tripped = false;
  let stopped = false;

  const check = () => {
    if (stopped || tripped) return;
    let used;
    try {
      used = usage();
    } catch (e) {
      console.log('Memory watchdog read failed:', e.message);
      return;
    }
    if (used > threshold) {
      tripped = true;
      console.log(`Memory pressure: ${formatMB(used)} of ${formatMB(max)} (threshold ${formatMB(threshold)}, ${sourceName()})`);
      try {
        onPressure({ usage: used, limit: max, ratio: used / max });
      } catch (e) {
        console.error('Memory pressure handler failed:', e);
      }
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
    },
    check,
    get tripped() { return tripped; },
    threshold
  };
}

module.exports = { usage, limit, watch, logUsage, describe, formatMB, sourceName, pressureRatio, MB };
