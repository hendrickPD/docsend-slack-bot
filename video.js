// DocSend videos are HLS streams served from Dropbox's preview CDN: a signed
// master playlist (fetchable without cookies for a while after the page load)
// listing one video rendition per resolution plus a separate AAC audio
// rendition. This module remuxes one rendition into an MP4 on disk with the
// ffmpeg binary that ffmpeg-static ships, copying the streams as they are, so
// nothing is transcoded and nothing but a few KB of playlist text is held in
// Node's memory.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

// Highest rendition to fetch; the 1080p rendition of a long video can be
// hundreds of MB.
const DEFAULT_MAX_HEIGHT = parseInt(process.env.VIDEO_MAX_HEIGHT, 10) || 1080;
// ffmpeg is killed after this long so a stalled CDN never wedges the queue.
const DEFAULT_TIMEOUT_MS = (parseInt(process.env.VIDEO_TIMEOUT_MINUTES, 10) || 20) * 60 * 1000;
// Slack refuses files over 1 GB.
const SLACK_MAX_BYTES = 1024 * 1024 * 1024;
const AUDIO_BANDWIDTH_FALLBACK = 128000;

function fetchText(url, { timeoutMs = 30000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).href, { timeoutMs, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching the video playlist`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Timed out fetching the video playlist')));
    req.on('error', reject);
  });
}

// KEY=VALUE,KEY="quoted, value" attribute lists of EXT-X-STREAM-INF / EXT-X-MEDIA.
function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return attrs;
}

/**
 * The renditions of an HLS master playlist: variants ({ uri, width, height,
 * bandwidth, name, audioGroup }) and the URI of each audio rendition group
 * (DEFAULT=YES preferred). A media playlist (no EXT-X-STREAM-INF) yields no
 * variants.
 */
function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const variants = [];
  const audioGroups = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if (a.TYPE === 'AUDIO' && a['GROUP-ID'] && a.URI) {
        const current = audioGroups[a['GROUP-ID']];
        if (!current || (a.DEFAULT === 'YES' && !current.isDefault)) {
          audioGroups[a['GROUP-ID']] = { uri: new URL(a.URI, baseUrl).href, isDefault: a.DEFAULT === 'YES' };
        }
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let j = i + 1;
      while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++;
      if (j >= lines.length) break;
      const [width, height] = (a.RESOLUTION || '0x0').split('x').map(n => parseInt(n, 10) || 0);
      variants.push({
        uri: new URL(lines[j], baseUrl).href,
        width,
        height,
        bandwidth: parseInt(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH, 10) || 0,
        name: a.NAME || (height ? `${height}p` : 'default'),
        audioGroup: a.AUDIO || null
      });
      i = j;
    }
  }
  const audio = {};
  for (const [group, { uri }] of Object.entries(audioGroups)) audio[group] = uri;
  return { variants, audio };
}

// Total EXTINF seconds of a media playlist.
function playlistDuration(text) {
  let total = 0;
  const re = /#EXTINF:([0-9.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) total += parseFloat(m[1]) || 0;
  return total;
}

function runFfmpeg(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    // Keep only the tail of stderr: ffmpeg repeats HTTP errors per segment.
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start ffmpeg: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffmpeg did not finish within ${Math.round(timeoutMs / 60000)} minutes`));
      } else if (code !== 0) {
        const lastLine = stderr.trim().split('\n').filter(Boolean).pop() || `exit ${code}${signal ? ` (${signal})` : ''}`;
        reject(new Error(`ffmpeg failed: ${lastLine.trim().slice(0, 300)}`));
      } else {
        resolve();
      }
    });
  });
}

async function remux({ videoUrl, audioUrl, outPath, timeoutMs }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin'];
  // -rw_timeout is a per-input protocol option (microseconds): a stalled
  // segment download errors out instead of hanging until the overall timeout.
  args.push('-rw_timeout', '60000000', '-i', videoUrl);
  if (audioUrl) args.push('-rw_timeout', '60000000', '-i', audioUrl);
  args.push('-map', '0:v:0');
  // Muxed audio (no separate rendition) is optional: a silent video still converts.
  args.push('-map', audioUrl ? '1:a:0' : '0:a:0?');
  args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', outPath);
  await runFfmpeg(args, { timeoutMs });
}

/**
 * Download the video behind an HLS master playlist URL to an MP4 file.
 * Picks the highest rendition no taller than maxHeight whose estimated size
 * fits maxBytes, falling back to the next smaller one if the result is still
 * too large. Resolves to { path, bytes, width, height, name, durationSec,
 * cleanup } where cleanup() deletes the file; the caller must call it.
 */
async function downloadVideo(playlistUrl, {
  maxHeight = DEFAULT_MAX_HEIGHT,
  maxBytes = SLACK_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outPath = null,
  log = console.log
} = {}) {
  if (!ffmpegPath) throw new Error('ffmpeg binary not available (ffmpeg-static did not install one for this platform)');
  const target = outPath || path.join(os.tmpdir(), `docsend-video-${crypto.randomBytes(6).toString('hex')}.mp4`);
  const cleanup = () => fs.promises.unlink(target).catch(() => {});

  const master = await fetchText(playlistUrl);
  const { variants, audio } = parseMasterPlaylist(master, playlistUrl);

  // Candidate renditions, best first. If every rendition is taller than the
  // cap, the smallest one is still better than nothing.
  let candidates = variants.filter(v => v.height && v.height <= maxHeight).sort((a, b) => b.height - a.height);
  if (candidates.length === 0 && variants.length > 0) {
    candidates = [variants.slice().sort((a, b) => a.height - b.height)[0]];
  }
  if (candidates.length === 0) {
    // Not a master playlist: a single media playlist with muxed audio.
    log('Video playlist has no renditions; remuxing it directly');
    await remux({ videoUrl: playlistUrl, audioUrl: null, outPath: target, timeoutMs });
    const { size } = await fs.promises.stat(target);
    return { path: target, bytes: size, width: 0, height: 0, name: 'default', durationSec: playlistDuration(master), cleanup };
  }

  let durationSec = 0;
  for (let i = 0; i < candidates.length; i++) {
    const variant = candidates[i];
    const isLast = i === candidates.length - 1;
    const audioUrl = variant.audioGroup ? audio[variant.audioGroup] || null : null;
    if (!durationSec) {
      try {
        durationSec = playlistDuration(await fetchText(variant.uri));
      } catch (e) {
        log(`Could not read the ${variant.name} playlist for a size estimate: ${e.message}`);
      }
    }
    const estimatedBytes = durationSec
      ? Math.round(((variant.bandwidth || 0) + (audioUrl ? AUDIO_BANDWIDTH_FALLBACK : 0)) * durationSec / 8)
      : 0;
    if (maxBytes && estimatedBytes > maxBytes && !isLast) {
      log(`Skipping ${variant.name}: about ${Math.round(estimatedBytes / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit`);
      continue;
    }
    log(`Downloading ${variant.name} (${variant.width}x${variant.height}${durationSec ? `, ${Math.round(durationSec)} s` : ''}${estimatedBytes ? `, about ${Math.round(estimatedBytes / 1048576)} MB` : ''}) with ffmpeg...`);
    await cleanup();
    await remux({ videoUrl: variant.uri, audioUrl, outPath: target, timeoutMs });
    const { size } = await fs.promises.stat(target);
    if (size === 0) {
      await cleanup();
      throw new Error('ffmpeg produced an empty file');
    }
    if (maxBytes && size > maxBytes && !isLast) {
      log(`${variant.name} came out at ${Math.round(size / 1048576)} MB, over the limit; trying a smaller rendition`);
      continue;
    }
    if (maxBytes && size > maxBytes) {
      await cleanup();
      throw new Error(`even the smallest rendition is ${Math.round(size / 1048576)} MB, over Slack's ${Math.round(maxBytes / 1048576)} MB limit`);
    }
    return { path: target, bytes: size, width: variant.width, height: variant.height, name: variant.name, durationSec, cleanup };
  }
  await cleanup();
  throw new Error('No rendition of the video could be downloaded');
}

module.exports = { downloadVideo, parseMasterPlaylist, playlistDuration, SLACK_MAX_BYTES, DEFAULT_MAX_HEIGHT, ffmpegPath };
