const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// In-flight job state that survives a restart. Render wipes the filesystem
// when the instance restarts (and the OOM killer takes the in-memory queue
// with it), so the state lives in Slack: one message per job in a private
// state channel (STATE_CHANNEL_ID), updated after every posted document and
// deleted when the job ends. Without STATE_CHANNEL_ID a marker file under
// os.tmpdir() does the same for local runs.
//
// The message is a short human line plus one gzip+base64 line: Slack would
// rewrite URLs and escape &, < and > inside raw JSON, and the cookies of the
// authorized DocSend session are the bulk of it (about 2KB packed).

const MARKER = 'docsend-job-state:v1:';
const DEFAULT_MAX_RESUME_ATTEMPTS = 2;

function encodeState(state) {
  return MARKER + zlib.gzipSync(Buffer.from(JSON.stringify(state), 'utf8')).toString('base64');
}

function decodeState(text) {
  if (typeof text !== 'string') return null;
  const at = text.indexOf(MARKER);
  if (at < 0) return null;
  const packed = text.slice(at + MARKER.length).trim().split(/\s+/)[0];
  try {
    return JSON.parse(zlib.gunzipSync(Buffer.from(packed, 'base64')).toString('utf8'));
  } catch (e) {
    return null;
  }
}

// Only what page.setCookie needs to re-enter the session.
function trimCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : []).map(c => {
    const t = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' };
    if (typeof c.expires === 'number' && c.expires > 0) t.expires = c.expires;
    if (c.httpOnly) t.httpOnly = true;
    if (c.secure) t.secure = true;
    if (c.sameSite) t.sameSite = c.sameSite;
    return t;
  });
}

function summaryLine(state) {
  const where = state.total
    ? `next document ${Math.min(state.nextIndex + 1, state.total)} of ${state.total}`
    : 'not started';
  return `Converting ${state.docUrl} (thread ${state.channel}/${state.threadTs}, attempt ${state.attempts || 0}): ${where}`;
}

function renderMessage(state) {
  return `${summaryLine(state)}\n${encodeState(state)}`;
}

class SlackStateStore {
  constructor(client, channelId) {
    this.client = client;
    this.channelId = channelId;
    this.kind = `Slack channel ${channelId}`;
  }

  async begin(state) {
    const result = await this.client.chat.postMessage({
      channel: this.channelId,
      text: renderMessage(state),
      unfurl_links: false,
      unfurl_media: false
    });
    return { ts: result.ts };
  }

  async update(handle, state) {
    await this.client.chat.update({
      channel: this.channelId,
      ts: handle.ts,
      text: renderMessage(state)
    });
  }

  async end(handle) {
    await this.client.chat.delete({ channel: this.channelId, ts: handle.ts }).catch(e => {
      if (e.data?.error !== 'message_not_found') throw e;
    });
  }

  async list() {
    const result = await this.client.conversations.history({ channel: this.channelId, limit: 200 });
    const jobs = [];
    for (const message of result.messages || []) {
      const state = decodeState(message.text);
      if (state) jobs.push({ handle: { ts: message.ts }, state });
    }
    // Oldest first, so resumed jobs run in the order they were posted.
    jobs.sort((a, b) => Number(a.handle.ts) - Number(b.handle.ts));
    return jobs;
  }
}

class DiskStateStore {
  constructor(dir = path.join(os.tmpdir(), 'docsend-slack-bot-jobs')) {
    this.dir = dir;
    this.kind = `disk marker files in ${dir}`;
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  async begin(state) {
    fs.mkdirSync(this.dir, { recursive: true });
    const id = state.id || crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(this.file(id), JSON.stringify(state));
    return { id };
  }

  async update(handle, state) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(handle.id), JSON.stringify(state));
  }

  async end(handle) {
    try { fs.unlinkSync(this.file(handle.id)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }

  async list() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch (e) { return []; }
    const jobs = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const state = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        jobs.push({ handle: { id: name.slice(0, -5) }, state });
      } catch (e) {
        console.log(`Ignoring unreadable job marker ${name}: ${e.message}`);
      }
    }
    jobs.sort((a, b) => (a.state.createdAt || 0) - (b.state.createdAt || 0));
    return jobs;
  }
}

function createStore({ client, channelId = process.env.STATE_CHANNEL_ID } = {}) {
  if (channelId && client) return new SlackStateStore(client, channelId);
  console.log('STATE_CHANNEL_ID is not set: job resume is disk-only and will not survive a Render restart (set it to a private channel the bot is a member of)');
  return new DiskStateStore();
}

/**
 * The state record of one conversion job while it runs. begin() posts it,
 * documentPosted(index) and session(cookies) update it, finish() deletes it.
 * Every store call is serialized and failures are logged, never thrown: a
 * broken state channel must not break the conversion itself.
 */
function trackJob(store, fields, { resume = null } = {}) {
  const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
  const state = resume
    ? { ...resume.state, ...given, attempts: (resume.state.attempts || 0) + 1, updatedAt: Date.now() }
    : {
        id: crypto.randomBytes(8).toString('hex'),
        ...fields,
        cookies: trimCookies(fields.cookies),
        nextIndex: fields.nextIndex || 0,
        total: fields.total || null,
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
  let handle = resume ? resume.handle : null;
  let chain = Promise.resolve();
  let finished = false;

  const queue = (label, fn) => {
    chain = chain.then(fn).catch(e => console.error(`Job state ${label} failed:`, e.data?.error || e.message));
    return chain;
  };

  const save = (label) => queue(label, async () => {
    if (finished) return;
    state.updatedAt = Date.now();
    if (handle) await store.update(handle, state);
    else handle = await store.begin(state);
  });

  if (resume) save('resume'); else save('begin');

  return {
    get state() { return state; },
    session(cookies) {
      state.cookies = trimCookies(cookies);
      return save('session');
    },
    documentPosted(index, total, title) {
      state.nextIndex = index + 1;
      if (total) state.total = total;
      if (title) state.title = title;
      return save('document');
    },
    finish() {
      return queue('finish', async () => {
        finished = true;
        if (handle) await store.end(handle);
        handle = null;
      });
    }
  };
}

/**
 * On startup: every job whose state is still stored was cut off by a restart.
 * Tell its thread, then hand it to runJob(state, handle) to carry on from
 * state.nextIndex. Jobs that already resumed maxAttempts times are dropped
 * with a message instead, so a document that kills the instance every time
 * cannot keep it in a restart loop.
 */
async function resumeInterrupted(store, { postMessage, runJob, maxAttempts = DEFAULT_MAX_RESUME_ATTEMPTS }) {
  let jobs;
  try {
    jobs = await store.list();
  } catch (e) {
    console.error(`Could not read interrupted jobs from ${store.kind}:`, e.data?.error || e.message);
    return [];
  }
  if (jobs.length === 0) {
    console.log(`No interrupted jobs in ${store.kind}`);
    return [];
  }
  console.log(`${jobs.length} interrupted job(s) in ${store.kind}`);
  const resumed = [];
  for (const { handle, state } of jobs) {
    const attempts = state.attempts || 0;
    const where = state.total ? `document ${Math.min(state.nextIndex + 1, state.total)} of ${state.total}` : 'the start';
    if (attempts >= maxAttempts) {
      console.log(`Giving up on ${state.docUrl} after ${attempts} resume attempts`);
      await postMessage({
        channel: state.channel, thread_ts: state.threadTs,
        text: `This conversion was interrupted by a restart ${attempts} times (last at ${where}), so I'm not retrying it again. If the rest of the dataroom is needed, post the link again.`
      }).catch(e => console.error('Could not post the give-up notice:', e.data?.error || e.message));
      await store.end(handle).catch(e => console.error('Could not delete the job state:', e.data?.error || e.message));
      continue;
    }
    console.log(`Resuming ${state.docUrl} from ${where} (attempt ${attempts + 1})`);
    await postMessage({
      channel: state.channel, thread_ts: state.threadTs,
      text: `This conversion was interrupted by a restart. Resuming from ${where}...`
    }).catch(e => console.error('Could not post the resume notice:', e.data?.error || e.message));
    try {
      await runJob(state, handle);
      resumed.push(state);
    } catch (e) {
      console.error(`Could not resume ${state.docUrl}:`, e.message);
    }
  }
  return resumed;
}

module.exports = {
  MARKER,
  encodeState,
  decodeState,
  trimCookies,
  SlackStateStore,
  DiskStateStore,
  createStore,
  trackJob,
  resumeInterrupted
};
