#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { convertDocSendToPDF, createPDFFromScreenshots } = require('./docsend');

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
  try {
    screenshots = await convertDocSendToPDF(url, messageText, {
      launchOptions,
      onCheckpoint,
      keepOpenOnError: keepOpen && !headless,
    });
    console.log(`Captured ${screenshots.length} screenshots`);
  } catch (e) {
    console.error(`FAILED: ${e.stack || e.message}`);
    console.error(`Artifacts in: ${outDir}`);
    traceFile.end();
    process.exit(1);
  }

  if (!noPdf) {
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
