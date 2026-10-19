#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { convertDocSendToPDF, createPDFFromScreenshots } = require('./docsend');
const { downloadVideo } = require('./video');

function usage() {
  console.error(`
Usage: node debug.js <docsend-url> [pw:PASSWORD] [flags]

Flags:
  --headless         Run headless (default: headful, so you can watch)
  --keep-open        Leave browser open on error for DevTools inspection
  --devtools         Launch Chrome DevTools alongside the page
  --slow-mo=MS       Slow each puppeteer action by MS ms (default: 50 when headful)
  --no-pdf           Skip building the output PDF
  --out-dir=PATH     Override output directory (default: ./debug/<timestamp>)
  --verify-url=URL   Resume after an email-verification wall with the link
                     DocSend emailed (a previous run wrote cookies.json; pass
                     it with --cookies=PATH to reuse that session)
  --cookies=PATH     cookies.json from the run that hit the verification wall
  --email=ADDRESS    Email to enter instead of DOCSEND_EMAIL
  --video-out=PATH   For a video document, download its MP4 to PATH (with
                     several videos in a dataroom: PATH-1.mp4, PATH-2.mp4, ...).
                     Without it the playlist URL is only printed.
                     VIDEO_MAX_HEIGHT caps the rendition (default 1080).

Artifacts written per checkpoint:
  NN-<step>.png         Full-page screenshot
  NN-<step>.html        page.content() HTML dump
  NN-<step>.frames.json List of all frames (url, name)
  NN-<step>.state.json  Buttons/inputs/iframes from the relevant context
  NN-<step>.extra.json  Checkpoint-specific extras (if provided)
  trace.log             All stdout/stderr from the run
  output.pdf            Built PDF (unless --no-pdf)
`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) usage();

const verifyUrlArg = argv.find(a => a.startsWith('--verify-url='));
const verifyUrl = verifyUrlArg ? verifyUrlArg.slice('--verify-url='.length) : null;
const cookiesArg = argv.find(a => a.startsWith('--cookies='));
const emailArg = argv.find(a => a.startsWith('--email='));
const emailOverride = emailArg ? emailArg.slice('--email='.length) : undefined;
const videoOutArg = argv.find(a => a.startsWith('--video-out='));
const videoOut = videoOutArg ? videoOutArg.slice('--video-out='.length) : null;
const url = argv.find(a => /^https?:\/\//.test(a));
if (!url) {
  console.error('ERROR: no URL provided');
  usage();
}
const pwArg = argv.find(a => a.toLowerCase().startsWith('pw:'));
const messageText = pwArg ? `${url} ${pwArg}` : url;

const headless = argv.includes('--headless');
const keepOpen = argv.includes('--keep-open');
const devtools = argv.includes('--devtools');
const noPdf = argv.includes('--no-pdf');
const slowMoArg = argv.find(a => a.startsWith('--slow-mo='));
const slowMo = slowMoArg ? Number(slowMoArg.split('=')[1]) : (headless ? 0 : 50);
const outDirArg = argv.find(a => a.startsWith('--out-dir='));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = outDirArg ? outDirArg.split('=')[1] : path.join('debug', stamp);
fs.mkdirSync(outDir, { recursive: true });

const traceFile = fs.createWriteStream(path.join(outDir, 'trace.log'));
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
function tee(stream, level) {
  return (...args) => {
    const line = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    traceFile.write(`[${level} ${new Date().toISOString()}] ${line}\n`);
    stream(...args);
  };
}
console.log = tee(origLog, 'LOG');
console.error = tee(origErr, 'ERR');

let counter = 0;

async function collectState(ctx) {
  if (!ctx) return null;
  try {
    return await ctx.evaluate(() => {
      const visible = el => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
               && el.offsetWidth > 0 && el.offsetHeight > 0;
      };
      const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')].map(b => ({
        tag: b.tagName,
        text: (b.innerText || b.value || '').trim().slice(0, 120),
        type: b.type || null,
        disabled: b.disabled || null,
        id: b.id || null,
        classes: b.className || null,
        ariaLabel: b.getAttribute('aria-label'),
        visible: visible(b)
      }));
      const inputs = [...document.querySelectorAll('input, textarea')].map(i => ({
        tag: i.tagName,
        type: i.type || null,
        name: i.name || null,
        id: i.id || null,
        placeholder: i.placeholder || null,
        ariaLabel: i.getAttribute('aria-label'),
        value: i.type === 'password' ? '***' : (i.value || '').slice(0, 120),
        visible: visible(i)
      }));
      const iframes = [...document.querySelectorAll('iframe')].map(f => ({
        src: f.src, id: f.id, name: f.name, classes: f.className
      }));
      return { url: location.href, buttons, inputs, iframes };
    });
  } catch (e) {
    return { error: e.message };
  }
}

async function onCheckpoint(name, { page, frame, extra } = {}) {
  if (!page) return;
  const n = String(++counter).padStart(2, '0');
  const base = path.join(outDir, `${n}-${name}`);
  console.log(`[checkpoint] ${n}-${name}`);

  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(e =>
    console.log(`  screenshot failed: ${e.message}`));

  try {
    fs.writeFileSync(`${base}.html`, await page.content());
  } catch (e) {
    console.log(`  html dump failed: ${e.message}`);
  }

  try {
    const frames = page.frames().map(f => ({ url: f.url(), name: f.name(), detached: f.isDetached() }));
    fs.writeFileSync(`${base}.frames.json`, JSON.stringify(frames, null, 2));
  } catch (e) {
    console.log(`  frames dump failed: ${e.message}`);
  }

  // Session cookies at each step, so a run can be resumed or re-entered
  // (e.g. a verified dataroom session) without a fresh verification email.
  try {
    fs.writeFileSync(`${base}.cookies.json`, JSON.stringify(await page.cookies(), null, 2));
  } catch (e) {
    console.log(`  cookies dump failed: ${e.message}`);
  }

  const ctx = frame || page;
  const state = await collectState(ctx);
  if (state) {
    fs.writeFileSync(`${base}.state.json`, JSON.stringify(state, null, 2));
  }

  if (extra !== undefined) {
    fs.writeFileSync(`${base}.extra.json`, JSON.stringify(extra, null, 2));
  }
}

(async () => {
  console.log(`Debug session: ${outDir}`);
  console.log(`URL: ${url}`);
  console.log(`Password: ${pwArg ? 'yes (from pw: arg)' : 'no'}`);
  console.log(`Headless: ${headless}  keepOpen: ${keepOpen}  devtools: ${devtools}  slowMo: ${slowMo}ms`);
  console.log(`DOCSEND_EMAIL: ${process.env.DOCSEND_EMAIL ? 'set' : 'NOT SET — will fail'}`);
  if (verifyUrl) console.log(`Verification link: ${verifyUrl}`);
  let cookies = null;
  if (cookiesArg) {
    const cookiesPath = cookiesArg.split('=')[1];
    cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
    console.log(`Cookies: ${cookies.length} from ${cookiesPath}`);
  }
  console.log('');

  const executablePath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    (process.platform === 'darwin' && fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined);

  const launchOptions = {
    headless: headless ? 'new' : false,
    slowMo,
    devtools,
    ...(executablePath ? { executablePath } : {}),
  };
  if (executablePath) console.log(`Using Chrome: ${executablePath}`);

  let screenshots;
  let dataroom = null;
  let videoDoc = null;
  try {
    const result = await convertDocSendToPDF(url, messageText, {
      launchOptions,
      onCheckpoint,
      keepOpenOnError: keepOpen && !headless,
      verifyUrl,
      cookies,
      ...(emailOverride ? { email: emailOverride } : {}),
    });
    if (result && result.dataroom) {
      dataroom = result;
      console.log(`Dataroom "${result.title}": ${result.documents.length} document(s)`);
      result.documents.forEach((d, i) =>
        console.log(`  ${i + 1}. ${d.folder ? `${d.folder} / ` : ''}${d.title} — ${d.error ? `FAILED: ${d.error}` : d.video ? `video (${d.playlistUrl})` : `${d.screenshots.length} pages`}`)
      );
    } else if (result && result.video) {
      videoDoc = result;
      console.log(`Video document "${result.title}"`);
      console.log(`  playlist: ${result.playlistUrl}`);
      if (result.thumbUrl) console.log(`  thumbnail: ${result.thumbUrl}`);
    } else {
      screenshots = result;
      console.log(`Captured ${screenshots.length} screenshots`);
    }
  } catch (e) {
    if (e.code === 'PASSCODE_REQUIRED') {
      console.log('PASSCODE REQUIRED: this link has a passcode gate. Re-run with pw:<passcode> after the URL.');
      traceFile.end();
      process.exit(3);
    }
    if (e.code === 'EMAIL_VERIFICATION_REQUIRED') {
      const cookiesPath = path.join(outDir, 'cookies.json');
      fs.writeFileSync(cookiesPath, JSON.stringify(e.cookies || [], null, 2));
      console.log(`EMAIL VERIFICATION REQUIRED: DocSend emailed a link to ${e.email}.`);
      console.log(`Re-run with: node debug.js ${url} --verify-url='<link from email>' --cookies=${cookiesPath} ${headless ? '--headless' : ''}`);
      traceFile.end();
      process.exit(2);
    }
    console.error(`FAILED: ${e.stack || e.message}`);
    console.error(`Artifacts in: ${outDir}`);
    traceFile.end();
    process.exit(1);
  }

  // Videos: the MP4 is written only when asked for (--video-out), since the
  // 1080p rendition of a long video is large.
  async function writeVideo(doc, target) {
    console.log(`Downloading video "${doc.title}" to ${target}...`);
    const t0 = Date.now();
    const video = await downloadVideo(doc.playlistUrl, { outPath: target });
    console.log(`MP4 written: ${video.path} (${video.name} ${video.width}x${video.height}, ${(video.bytes / 1048576).toFixed(1)} MB, ${Math.round(video.durationSec)} s, took ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  if (videoDoc && videoOut) {
    try {
      await writeVideo(videoDoc, videoOut);
    } catch (e) {
      console.error(`Video download failed: ${e.message}`);
    }
  } else if (videoDoc) {
    console.log('Pass --video-out=PATH to download the MP4.');
  }

  if (!noPdf && dataroom) {
    fs.writeFileSync(path.join(outDir, 'dataroom.json'), JSON.stringify({
      title: dataroom.title,
      documents: dataroom.documents.map(d => ({ title: d.title, url: d.url, folder: d.folder, type: d.type, pages: d.screenshots ? d.screenshots.length : 0, video: !!d.video, playlistUrl: d.playlistUrl || null, error: d.error || null }))
    }, null, 2));
    const videos = dataroom.documents.filter(d => d.video);
    for (let v = 0; v < videos.length; v++) {
      if (!videoOut) {
        console.log(`Video "${videos[v].title}": pass --video-out=PATH to download the MP4.`);
        continue;
      }
      const target = videos.length === 1 ? videoOut : videoOut.replace(/(\.mp4)?$/i, `-${v + 1}.mp4`);
      try {
        await writeVideo(videos[v], target);
      } catch (e) {
        console.error(`Video download failed for ${videos[v].title}: ${e.message}`);
      }
    }
    for (let i = 0; i < dataroom.documents.length; i++) {
      const d = dataroom.documents[i];
      if (d.error || d.video) continue;
      const safe = d.title.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || `doc${i + 1}`;
      const pdfPath = path.join(outDir, `output-${String(i + 1).padStart(2, '0')}-${safe}.pdf`);
      try {
        fs.writeFileSync(pdfPath, await createPDFFromScreenshots(d.screenshots));
        console.log(`PDF written: ${pdfPath}`);
      } catch (e) {
        console.error(`PDF build failed for ${d.title}: ${e.message}`);
      }
    }
  } else if (!noPdf && screenshots) {
    try {
      const pdf = await createPDFFromScreenshots(screenshots);
      const pdfPath = path.join(outDir, 'output.pdf');
      fs.writeFileSync(pdfPath, pdf);
      console.log(`PDF written: ${pdfPath}`);
    } catch (e) {
      console.error(`PDF build failed: ${e.message}`);
    }
  }

  console.log(`Done. Artifacts in: ${outDir}`);
  traceFile.end();
})();
