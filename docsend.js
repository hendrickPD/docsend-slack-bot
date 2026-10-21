const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { DEFAULT_LAUNCH_ARGS, getSharedBrowser, closeSharedBrowser, shedBrowserMemory } = require('./browser');
const memory = require('./memory');

const noop = async () => {};

/**
 * A capture was stopped on purpose (memory pressure): the pages captured so
 * far are dropped and the caller decides what to tell the user.
 */
class CaptureAborted extends Error {
  constructor(reason) {
    super(`Capture aborted: ${reason}`);
    this.name = 'CaptureAborted';
    this.code = 'CAPTURE_ABORTED';
    this.reason = reason;
  }
}

// Shared between the memory watchdog (which sets it) and the capture loops
// (which check it between pages and before each screenshot).
class AbortFlag {
  constructor() { this.reason = null; }
  get aborted() { return this.reason !== null; }
  abort(reason) { if (this.reason === null) this.reason = reason || 'aborted'; }
  reset() { this.reason = null; }
  check() { if (this.reason !== null) throw new CaptureAborted(this.reason); }
}

// The memory watchdog asks for a shed; the capture loop grants it at its next
// page boundary, the only point where the viewer tab can be swapped for a
// fresh one. request() resolves when the loop has done so (true) or when
// nothing serviced it within timeoutMs (false: the other capture paths don't
// recycle, and a gate may be in the way).
class ShedRequests {
  constructor() { this.pending = null; }
  get requested() { return this.pending !== null; }
  request(timeoutMs = 30000) {
    if (this.pending) return this.pending.promise;
    const pending = {};
    pending.promise = new Promise(resolve => {
      pending.resolve = resolve;
      pending.timer = setTimeout(() => {
        if (this.pending === pending) this.pending = null;
        resolve(false);
      }, timeoutMs);
      if (pending.timer.unref) pending.timer.unref();
    });
    this.pending = pending;
    return pending.promise;
  }
  async service(fn) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    let ok = false;
    try {
      ok = await fn();
    } finally {
      pending.resolve(ok !== false);
    }
  }
}

// Page images are re-encoded no wider than SLIDE_MAX_WIDTH at
// SLIDE_JPEG_QUALITY: DocSend serves slides at 2048px, and the decoded
// bitmap of each page plus its JPEG is what the 512MB instance runs out of.
// Sources already narrower than the bound keep their size.
const DEFAULT_SLIDE_MAX_WIDTH = 1600;
const DEFAULT_SLIDE_JPEG_QUALITY = 75;

function slideMaxWidth() {
  const n = Number(process.env.SLIDE_MAX_WIDTH);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_SLIDE_MAX_WIDTH;
}

// 1-100, as puppeteer's screenshot quality; canvas wants it as 0-1.
function slideJpegQuality() {
  const n = Number(process.env.SLIDE_JPEG_QUALITY);
  return Number.isFinite(n) && n > 0 && n <= 100 ? Math.round(n) : DEFAULT_SLIDE_JPEG_QUALITY;
}

// Runs inside the page (passed to ElementHandle.evaluate, so it must not
// close over anything): draw the decoded <img> onto a canvas no wider than
// maxWidth and return it as a JPEG data URL.
function encodeBoundedJpeg(el, maxWidth, quality) {
  const srcW = el.naturalWidth || el.width;
  const srcH = el.naturalHeight || el.height;
  const scale = srcW > maxWidth ? maxWidth / srcW : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d');
  if (scale < 1) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  const out = { dataUrl: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height, scaled: scale < 1 };
  // Release the bitmap now instead of when the GC gets to the canvas.
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

// Runs inside the page: fetch the image bytes (session cookies carry) and
// re-encode them under the same bound. When the bytes cannot be decoded as
// an image the raw bytes come back instead.
async function fetchBoundedJpeg(url, maxWidth, quality) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (scale < 1) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height, scaled: scale < 1 };
  } catch (e) {
    return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  }
}

function bufferFromEncoded(encoded) {
  if (encoded.dataUrl) return Buffer.from(encoded.dataUrl.split(',')[1], 'base64');
  return Buffer.from(encoded.bytes);
}

function describeEncoded(encoded) {
  return encoded.dataUrl
    ? `${encoded.width}x${encoded.height}${encoded.scaled ? ' (downscaled)' : ''}`
    : 'raw bytes';
}

/**
 * A clipped JPEG screenshot no wider than SLIDE_MAX_WIDTH. puppeteer 10 pins
 * the clip's scale to 1, so a downscaled capture goes straight to the
 * Page.captureScreenshot command; the plain path stays for clips already
 * within the bound.
 */
async function boundedClipScreenshot(page, clip, quality) {
  const maxWidth = slideMaxWidth();
  const scale = clip.width > maxWidth ? maxWidth / clip.width : 1;
  if (scale === 1) return page.screenshot({ type: 'jpeg', quality, clip });
  try {
    await page._client.send('Target.activateTarget', { targetId: page.target()._targetId }).catch(() => {});
    const result = await page._client.send('Page.captureScreenshot', {
      format: 'jpeg', quality,
      clip: { ...clip, scale },
      captureBeyondViewport: true
    });
    return Buffer.from(result.data, 'base64');
  } catch (e) {
    console.log(`  scaled screenshot failed (${e.message}); capturing at full size`);
    return page.screenshot({ type: 'jpeg', quality, clip });
  }
}

// A full-page screenshot of a long page (a web link rendered in the viewer, a
// tall vertical document that didn't take the per-image path) is one bitmap
// the size of the whole page; on the 512MB instance that OOM-killed the
// process. Capture at most MAX_FALLBACK_HEIGHT px of it.
const MAX_FALLBACK_HEIGHT = 4320;

async function boundedFullPageScreenshot(page, abort = new AbortFlag()) {
  abort.check();
  const { width, height } = await page.evaluate(() => ({
    width: document.documentElement.clientWidth || window.innerWidth,
    height: Math.max(
      document.documentElement.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0,
      window.innerHeight
    )
  })).catch(() => ({ width: 1920, height: 1080 }));
  if (height <= MAX_FALLBACK_HEIGHT) {
    return page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
  }
  console.log(`  page is ${height}px tall; capturing the first ${MAX_FALLBACK_HEIGHT}px only`);
  return page.screenshot({
    type: 'jpeg', quality: 80,
    clip: { x: 0, y: 0, width: Math.max(1, width), height: MAX_FALLBACK_HEIGHT }
  });
}

async function dismissCookieBanner(page) {
  console.log('Attempting to dismiss cookie banners...');
  try {
    await page.evaluate(() => {
      const cookieBanner = document.querySelector('#onetrust-consent-sdk');
      if (cookieBanner) cookieBanner.remove();
    });
    console.log('Removed cookie banner if present');
  } catch (error) {
    console.log('No cookie banner to remove or error removing it:', error);
  }
}

/**
 * Some links have the owner's "verify email" option on: after the viewer
 * submits their email, DocSend shows a "Check your email to continue" modal
 * and emails a one-time verification link. Nothing on the page gets us past
 * it, so the caller has to come back with that link (see opts.verifyUrl).
 */
class EmailVerificationRequired extends Error {
  constructor(email, cookies) {
    super(`DocSend sent a verification link to ${email}; open it to continue`);
    this.name = 'EmailVerificationRequired';
    this.code = 'EMAIL_VERIFICATION_REQUIRED';
    this.email = email;
    this.cookies = cookies;
  }
}

/**
 * The link has a passcode gate and the message carried no pw:<passcode>.
 * Nothing on the page gets us past it, so the caller has to come back with
 * the passcode (app.js asks for it in the thread).
 */
class PasscodeRequired extends Error {
  constructor(cookies) {
    super('This DocSend link requires a passcode');
    this.name = 'PasscodeRequired';
    this.code = 'PASSCODE_REQUIRED';
    this.cookies = cookies;
  }
}

/**
 * The link asks for an email and the caller gave none (opts.email null:
 * the poster's address could not be read from Slack). Ask instead of
 * entering a shared address on their behalf.
 */
class EmailRequired extends Error {
  constructor(cookies) {
    super('This DocSend link asks for an email address');
    this.name = 'EmailRequired';
    this.code = 'EMAIL_REQUIRED';
    this.cookies = cookies;
  }
}

/**
 * DocSend refused the address we typed ("must be a valid email address that
 * can receive messages", or the document is restricted to other addresses):
 * the gate is still showing with an error. Ask for another address.
 */
class EmailRejected extends Error {
  constructor(email, reason, cookies) {
    super(`DocSend rejected the email address ${email}: ${reason}`);
    this.name = 'EmailRejected';
    this.code = 'EMAIL_REJECTED';
    this.email = email;
    this.reason = reason;
    this.cookies = cookies;
  }
}

// After an email submit: is the gate still up with a validation error?
async function detectEmailRejection(page) {
  const probe = ctx => ctx.evaluate(() => {
    const visible = el => {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0;
    };
    const input = document.querySelector('input[type="email"], input[name="email"]');
    if (!visible(input)) return null;
    const text = document.body.innerText || '';
    const m = text.match(/must be a valid email[^\n]*|not (?:authorized|allowed) to view[^\n]*|doesn't have access[^\n]*|does not have access[^\n]*|review the problems[^\n]*/i);
    return m ? m[0].trim() : null;
  }).catch(() => null);
  const main = await probe(page);
  if (main) return main;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const r = await probe(frame);
    if (r) return r;
  }
  return null;
}

async function requireEmail(page, email) {
  if (email) return;
  console.log('Email gate detected but no email is known; asking the caller for one');
  throw new EmailRequired(await page.cookies().catch(() => []));
}

// A visible passcode field on the page or in any frame.
async function detectPasscodeGate(page) {
  const probe = ctx => ctx.evaluate(() => {
    const visible = el => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0;
    };
    return [...document.querySelectorAll(
      'input[type="password"], input[name="passcode"], input[name="passCode"], input[placeholder*="asscode"]'
    )].some(visible);
  }).catch(() => false);
  if (await probe(page)) return true;
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && await probe(frame)) return true;
  }
  return false;
}

async function detectEmailVerificationWall(page) {
  try {
    return await page.evaluate(() => {
      const visible = el => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0;
      };
      // Classic viewer: a Bootstrap modal. Dataroom (React app): a
      // .ReactModal__Content dialog with the same "Check your email" copy.
      const prompt = document.querySelector('#prompt.modal, .modal.in, .ReactModal__Content[role="dialog"]');
      const text = (prompt && visible(prompt)) ? prompt.innerText : '';
      const bodyAuthorize = document.body.dataset.action === 'authorize'
        && document.body.classList.contains('modal-open');
      return /check your email|verification link/i.test(text)
        || (bodyAuthorize && /verification link/i.test(document.body.innerText));
    });
  } catch (e) {
    console.log('Verification-wall check failed:', e.message);
    return false;
  }
}

/**
 * Capture a "vertical" DocSend doc (body.vertical). Unlike slide decks,
 * vertical docs stack all pages in the DOM as <img class="preso-view page-view">
 * with data-pagenum. ArrowRight does nothing useful here, so we iterate the
 * image elements directly and screenshot each one at its natural resolution.
 */
async function captureVerticalPages(page, { onCheckpoint = noop, abort = new AbortFlag() } = {}) {
  console.log('Capturing vertical document pages (per-image strategy)...');
  const maxWidth = slideMaxWidth();
  const quality = slideJpegQuality();
  // Hide UI chrome + cookie banner so nothing overlays the page images
  await page.evaluate(() => {
    const selectors = [
      'header', '.header', '.top-bar', '.presentation-toolbar',
      '.navbar-fixed-bottom', '.bottom-bar', '.presentation-fixed-footer',
      '#onetrust-consent-sdk'
    ];
    selectors.forEach(sel =>
      document.querySelectorAll(sel).forEach(el => el.style.display = 'none')
    );
  });
  await page.waitForTimeout(1500);
  await onCheckpoint('capture-ready-vertical', { page });

  const handles = await page.$$('img.preso-view.page-view');
  console.log(`Found ${handles.length} vertical page images`);
  if (handles.length === 0) {
    throw new Error('No img.preso-view.page-view elements found on vertical doc');
  }

  const originalViewport = page.viewport();
  let viewportDirty = false;

  const screenshots = [];
  for (let i = 0; i < handles.length; i++) {
    abort.check();
    const img = handles[i];

    // Scroll the image into view FIRST — vertical docs lazy-load page images,
    // so below-the-fold pages may not even have a real src until visible.
    await img.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));

    // Wait for image fully decoded
    await img.evaluate(el => {
      if (el.complete && el.naturalWidth > 0) return;
      return new Promise(resolve => {
        const done = () => resolve();
        el.addEventListener('load', done, { once: true });
        el.addEventListener('error', done, { once: true });
        setTimeout(done, 5000);
      });
    });

    const info = await img.evaluate(el => ({
      src: el.src,
      pageNum: el.getAttribute('data-pagenum'),
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
      complete: el.complete
    }));
    console.log(`Page ${i + 1}/${handles.length} (pagenum=${info.pageNum}, ${info.naturalWidth}x${info.naturalHeight}, complete=${info.complete})`);

    let shot = null;

    // Strategy 1: re-encode the already-decoded <img> through a canvas, no
    // wider than SLIDE_MAX_WIDTH. No new network request, so it can't hit
    // expired signed URLs. Requires --disable-web-security (canvas taint).
    if (info.naturalWidth > 0) {
      abort.check();
      try {
        const encoded = await img.evaluate(encodeBoundedJpeg, maxWidth, quality / 100);
        shot = bufferFromEncoded(encoded);
        console.log(`  canvas re-encode: ${shot.length} bytes, ${describeEncoded(encoded)}`);
      } catch (canvasErr) {
        console.log(`  canvas re-encode failed (${canvasErr.message})`);
      }
    }

    // Strategy 2: fetch the image bytes from its URL in the browser context
    // (session cookies carry) and re-encode them under the same bound.
    if (!shot) {
      abort.check();
      try {
        const encoded = await page.evaluate(fetchBoundedJpeg, info.src, maxWidth, quality / 100);
        shot = bufferFromEncoded(encoded);
        console.log(`  fetched from CDN: ${shot.length} bytes, ${describeEncoded(encoded)}`);
      } catch (fetchErr) {
        console.log(`  direct fetch failed (${fetchErr.message}), falling back to screenshot`);
      }
    }

    // Strategy 3: element screenshot with the viewport grown to fit the whole
    // page image. Chromium paints regions outside the viewport BLACK when
    // screenshotting past it (this is what produced half-black PDF pages), so
    // never capture beyond the viewport — make the viewport big enough instead.
    if (!shot) {
      abort.check();
      const rect = await img.evaluate(el => {
        const r = el.getBoundingClientRect();
        return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
      });
      const needW = Math.max(originalViewport.width, rect.width);
      const needH = Math.max(originalViewport.height, rect.height);
      if (page.viewport().width < needW || page.viewport().height < needH) {
        await page.setViewport({ width: needW, height: needH });
        viewportDirty = true;
      }
      await img.evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(500);
      shot = await img.screenshot({ type: 'jpeg', quality });
      console.log(`  element screenshot: ${shot.length} bytes`);
    }

    screenshots.push(shot);
    await onCheckpoint(`capture-vertical-page-${i + 1}`, { page, extra: info });
  }

  if (viewportDirty) {
    await page.setViewport(originalViewport);
  }

  console.log(`Captured ${screenshots.length} vertical pages`);
  return screenshots;
}

/**
 * Capture the currently-active slide image of a DocSend deck. Decks render each
 * slide as <img class="preso-view page-view" data-pagenum="N">; only the active
 * slide is shown at a time and advanced with ArrowRight. Grabbing the decoded
 * <img> bytes (canvas re-encode, then CDN fetch) instead of a viewport
 * screenshot avoids the blank/white pages that happen when the screenshot fires
 * before the slide has painted. Returns a Buffer, or null when no slide <img> is
 * present so the caller can fall back to a full-page screenshot.
 */
async function captureSlideImage(page, pageNum, { abort = new AbortFlag() } = {}) {
  abort.check();
  const maxWidth = slideMaxWidth();
  const quality = slideJpegQuality();
  const handle = await page.evaluateHandle((pn) => {
    const imgs = Array.from(document.querySelectorAll('img.preso-view.page-view'));
    if (imgs.length === 0) return null;
    // Prefer the image whose data-pagenum matches the reported page number.
    if (pn !== null && pn !== undefined) {
      const match = imgs.find(el => String(el.getAttribute('data-pagenum')) === String(pn));
      if (match) return match;
    }
    // Otherwise the largest currently-visible slide image (the active slide).
    const visible = imgs
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) => {
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      })
      .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    return visible.length ? visible[0].el : null;
  }, pageNum);

  const img = handle.asElement();
  if (!img) {
    await handle.dispose();
    return null;
  }

  try {
    // Wait for the slide image to finish decoding before reading its pixels.
    await img.evaluate(el => {
      if (el.complete && el.naturalWidth > 0) return;
      return new Promise(resolve => {
        const done = () => resolve();
        el.addEventListener('load', done, { once: true });
        el.addEventListener('error', done, { once: true });
        setTimeout(done, 5000);
      });
    });

    const info = await img.evaluate(el => ({
      src: el.src,
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight
    }));
    console.log(`  slide image ${info.naturalWidth}x${info.naturalHeight} (reported page ${pageNum})`);

    // Strategy 1: re-encode the already-decoded <img> through a canvas, no
    // wider than SLIDE_MAX_WIDTH. No new network request (can't hit expired
    // signed URLs). Requires --disable-web-security for the cross-origin read.
    if (info.naturalWidth > 0) {
      abort.check();
      try {
        const encoded = await img.evaluate(encodeBoundedJpeg, maxWidth, quality / 100);
        const buf = bufferFromEncoded(encoded);
        console.log(`  canvas re-encode: ${buf.length} bytes, ${describeEncoded(encoded)}`);
        return buf;
      } catch (canvasErr) {
        console.log(`  canvas re-encode failed (${canvasErr.message})`);
      }
    }

    // Strategy 2: fetch the image bytes from its URL in the page context
    // (session cookies carry) and re-encode them under the same bound.
    if (info.src) {
      abort.check();
      try {
        const encoded = await page.evaluate(fetchBoundedJpeg, info.src, maxWidth, quality / 100);
        const buf = bufferFromEncoded(encoded);
        console.log(`  fetched from CDN: ${buf.length} bytes, ${describeEncoded(encoded)}`);
        return buf;
      } catch (fetchErr) {
        console.log(`  direct fetch failed (${fetchErr.message})`);
      }
    }

    // Strategy 3: element screenshot of the slide image itself.
    abort.check();
    try {
      const shot = await img.screenshot({ type: 'jpeg', quality });
      console.log(`  element screenshot: ${shot.length} bytes`);
      return shot;
    } catch (shotErr) {
      console.log(`  element screenshot failed (${shotErr.message})`);
      return null;
    }
  } finally {
    await handle.dispose();
  }
}

/**
 * Spreadsheets aren't rendered as preso-view slides: DocSend embeds a Dropbox
 * previews iframe (name="previews-iframe", /p/xls_html/ URL) whose document
 * holds one div.sheet-content per workbook sheet — each a full HTML <table> —
 * toggled by a#tabstrip-link-N tabs and clipped by a fixed-height #wrapper.
 */
async function findSpreadsheetFrame(page) {
  const frame = page.frames().find(f => f.url().includes('previews.dropboxusercontent.com'));
  if (!frame) return null;
  if (frame.url().includes('/p/xls_html/')) return frame;
  const hasSheets = await frame.$('.sheet-content').catch(() => null);
  return hasSheets ? frame : null;
}

// Sheets larger than these bounds are clipped with a log line. As in the
// vertical-capture path above, Chromium paints regions outside the viewport
// BLACK when screenshotting past it, so each sheet's capture grows the
// viewport to fit the sheet — the height bound keeps that raster from blowing
// memory on the 512MB instance.
const SPREADSHEET_MAX_WIDTH = 4400;
const SPREADSHEET_MAX_HEIGHT = 8000;

async function captureSpreadsheetPages(page, frame, { onCheckpoint = noop, abort = new AbortFlag() } = {}) {
  const tabCount = await frame.$$eval('a.tabstrip-link', els => els.length).catch(() => 0);
  console.log(`Spreadsheet preview detected with ${tabCount} sheet tab(s)`);
  const quality = slideJpegQuality();

  // Hide the "Cookies & CCPA preferences" link (a.presentation-privacy-policy_text,
  // fixed to the viewport's bottom-right) and the consent iframe via a
  // stylesheet so neither is stamped onto the captures.
  await page.addStyleTag({
    content: '#ccpa-iframe, iframe[src*="ccpa"], [class*="presentation-privacy-policy"] { display: none !important; }'
  });

  // Let the iframe and its ancestors grow past the viewer's fixed-height clip
  // so the screenshot clip below can cover a whole sheet.
  await page.evaluate(() => {
    const iframe = document.getElementById('previews-iframe') ||
      document.querySelector('iframe[data-testid="spreadsheet-iframe"], iframe[name="previews-iframe"]');
    for (let el = iframe && iframe.parentElement; el; el = el.parentElement) {
      el.style.overflow = 'visible';
      el.style.maxHeight = 'none';
      if (el.style.height && el.style.height !== 'auto') el.style.height = 'auto';
    }
  });

  const originalViewport = page.viewport();

  const screenshots = [];
  const sheetCount = Math.max(tabCount, 1);
  for (let i = 0; i < sheetCount; i++) {
    abort.check();
    if (tabCount > 0) {
      const label = await frame.evaluate((idx) => {
        const link = document.getElementById(`tabstrip-link-${idx}`);
        if (!link) return null;
        link.click();
        return link.textContent.trim();
      }, i);
      console.log(`Capturing sheet ${i + 1}/${sheetCount}: ${label}`);
      await frame.waitForFunction((idx) => {
        const sheet = document.querySelectorAll('.sheet-content')[idx];
        return sheet && sheet.style.display !== 'none';
      }, { timeout: 15000 }, i).catch(() =>
        console.log('  sheet did not become visible; capturing current state')
      );
      await page.waitForTimeout(400);
    }

    // Size the wrapper and iframe to the active sheet's full content.
    const dims = await frame.evaluate((idx, maxWidth) => {
      const sheet = document.querySelectorAll('.sheet-content')[idx] || document.body;
      const tabstrip = document.getElementById('tabstrip');
      const wrapper = document.getElementById('wrapper');
      if (wrapper) { wrapper.style.height = 'auto'; wrapper.style.overflow = 'visible'; }
      document.body.style.overflow = 'visible';
      window.scrollTo(0, 0);
      const contentW = Math.max(sheet.scrollWidth, 200) + 20;
      const contentH = Math.max(sheet.scrollHeight, 200) + (tabstrip ? tabstrip.offsetHeight : 0) + 20;
      const isEmpty = sheet.innerText.trim().length === 0 && !sheet.querySelector('img');
      return { contentW, contentH, isEmpty };
    }, i, SPREADSHEET_MAX_WIDTH);
    if (dims.isEmpty) {
      console.log('  sheet has no content; skipping');
      continue;
    }
    const sheetW = Math.min(dims.contentW, SPREADSHEET_MAX_WIDTH);
    const sheetH = Math.min(dims.contentH, SPREADSHEET_MAX_HEIGHT);
    if (dims.contentW > SPREADSHEET_MAX_WIDTH) {
      console.log(`  sheet is ${dims.contentW}px wide; clipping to ${SPREADSHEET_MAX_WIDTH}px`);
    }
    if (dims.contentH > SPREADSHEET_MAX_HEIGHT) {
      console.log(`  sheet is ${dims.contentH}px tall; clipping to ${SPREADSHEET_MAX_HEIGHT}px`);
    }

    const box = await page.evaluate((w, h) => {
      const iframe = document.getElementById('previews-iframe') ||
        document.querySelector('iframe[data-testid="spreadsheet-iframe"], iframe[name="previews-iframe"]');
      iframe.style.width = `${w}px`;
      iframe.style.height = `${h}px`;
      iframe.style.maxWidth = 'none';
      window.scrollTo(0, 0);
      const rect = iframe.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: w, height: h };
    }, sheetW, sheetH);

    // Grow the viewport to contain the whole sheet, then screenshot the iframe
    // region — everything inside the viewport, so nothing paints black. The
    // viewport only ever grows across the loop: shrinking it between sheets
    // made Chromium's next rasterization come back solid black.
    const needW = Math.max(page.viewport().width, Math.ceil(box.x + box.width));
    const needH = Math.max(page.viewport().height, Math.ceil(box.y + box.height));
    if (needW > page.viewport().width || needH > page.viewport().height) {
      await page.setViewport({ width: needW, height: needH });
    }
    // Wait until the frame has actually painted at the new size.
    await frame.evaluate(() =>
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    ).catch(() => {});
    await page.waitForTimeout(300);

    const clip = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height)
    };
    // Discard the first capture after the viewport change: Chromium's first
    // rasterization at the new size can come back solid black.
    abort.check();
    await boundedClipScreenshot(page, clip, 30);
    // And occasionally the buffer itself is corrupt; retry once, then skip the
    // sheet rather than poison the whole PDF (createPDFFromScreenshots throws
    // on an invalid image).
    const isValidImage = b => Buffer.isBuffer(b) && b.length > 4 &&
      ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50));
    abort.check();
    let shot = await boundedClipScreenshot(page, clip, quality);
    if (!isValidImage(shot)) {
      console.log('  screenshot buffer invalid; retrying once');
      await page.waitForTimeout(500);
      abort.check();
      shot = await boundedClipScreenshot(page, clip, quality);
    }
    if (isValidImage(shot)) {
      console.log(`  captured ${clip.width}x${clip.height} sheet: ${shot.length} bytes`);
      screenshots.push(shot);
    } else {
      console.log(`  skipping sheet ${i + 1}: invalid screenshot buffer after retry`);
    }
    await onCheckpoint(`capture-sheet-${i + 1}`, { page, extra: { sheet: i + 1, of: sheetCount, ...dims } });
  }
  await page.setViewport(originalViewport);
  console.log(`Captured ${screenshots.length} spreadsheet page(s) across ${sheetCount} sheet(s)`);
  return screenshots;
}

// The page number the viewer's toolbar reports, or null without a counter.
async function currentPageNumber(page) {
  return page.evaluate(() => {
    const el = document.querySelector('span[aria-label="page number"]');
    return el ? parseInt(el.textContent, 10) : null;
  }).catch(() => null);
}

async function waitForViewerIdle(page) {
  await page.waitForFunction(
    () => !document.querySelector('.loading-spinner') && !document.querySelector('.loading'),
    { timeout: 30000 }
  );
}

// Hide the viewer chrome, focus the page and wait for the first slide image.
async function prepareDeckViewer(page) {
  await page.evaluate(() => {
    const selectors = [
      'header', '.header', '.top-bar', '.presentation-toolbar',
      '.navbar-fixed-bottom', '.bottom-bar', '.presentation-fixed-footer'
    ];
    selectors.forEach(sel =>
      document.querySelectorAll(sel).forEach(el => el.style.display = 'none')
    );
  });
  console.log('UI hidden; focusing page');
  const { width, height } = page.viewport();
  await page.mouse.click(width / 2, height / 2);
  await page.evaluate(() => {
    const el = document.querySelector('#onetrust-consent-sdk');
    if (el) el.style.display = 'none';
  });
  await waitForViewerIdle(page);
  // The preso-view waitForSelector below covers slide readiness; this is just
  // a short settle for layout after hiding the UI chrome.
  await page.waitForTimeout(1000);

  // Decks render each slide as <img class="preso-view page-view">. Wait for the
  // first one so we don't start capturing a blank viewer. If it never appears
  // (unexpected viewer markup) we still proceed and rely on full-page fallback.
  try {
    await page.waitForSelector('img.preso-view.page-view', { timeout: 15000 });
  } catch (e) {
    console.log('No preso-view slide image appeared within timeout; relying on full-page screenshots');
  }
}

/**
 * Show page `target` without stepping through the pages in between: the
 * toolbar's "Jump to Page" grid (#page-picker, one .document-thumb-container
 * per page) is tried first, then arrow keys. Each page the viewer shows costs
 * a decoded 2048px bitmap, so stepping is the fallback, not the default.
 */
async function jumpToPage(page, target) {
  let current = await currentPageNumber(page);
  if (current === null || current === target) return current;

  for (let attempt = 1; attempt <= 2 && current !== target; attempt++) {
    try {
      const thumb = `.document-thumb-container[data-page-num="${target}"]`;
      const gridVisible = await page.$eval('.page-grid', el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      }).catch(() => false);
      // The toolbar is hidden by prepareDeckViewer; the button still responds
      // to a DOM click.
      if (!gridVisible) await page.$eval('#page-picker', el => el.click());
      await page.waitForSelector(thumb, { visible: true, timeout: 5000 });
      // Let the grid finish animating in before clicking inside it.
      await page.waitForTimeout(700);
      await page.click(thumb);
      await page.waitForFunction(
        (t) => {
          const el = document.querySelector('span[aria-label="page number"]');
          return el && parseInt(el.textContent, 10) === t;
        },
        { timeout: 5000 },
        target
      ).catch(() => {});
      await page.waitForTimeout(400);
    } catch (e) {
      console.log(`  jump to page ${target} via the page grid failed (${e.message})`);
    }
    current = await currentPageNumber(page);
    if (current !== target) {
      // Close a grid that stayed open; the arrow keys below need the viewer.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      current = await currentPageNumber(page);
    }
  }
  if (current === target) {
    console.log(`  jumped to page ${target} via the page grid`);
    return current;
  }

  console.log(`  stepping from page ${current} to ${target} with the arrow keys`);
  for (let presses = 0; current !== null && current !== target && presses < 500; presses++) {
    await page.keyboard.press(current < target ? 'ArrowRight' : 'ArrowLeft');
    const before = current;
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('span[aria-label="page number"]');
        return el && parseInt(el.textContent, 10) !== prev;
      },
      { timeout: 2000 },
      before
    ).catch(() => {});
    current = await currentPageNumber(page);
    if (current === before) break; // the viewer won't move (last page, or a gate)
  }
  return current;
}

/**
 * Memory shed for a deck in progress: close the viewer tab (its renderer, and
 * with it every decoded slide the viewer kept, goes away), open a fresh one on
 * the same URL with the session cookies and show the page to continue at. The
 * old tab goes first so the two renderers never coexist on the 512MB instance.
 * Throws CaptureAborted when the fresh tab does not reach the viewer (an
 * expired session, a gate): the capture cannot continue without a tab.
 */
async function recycleViewerTab(page, { resumeAt, onPageReplaced = noop } = {}) {
  const url = page.url();
  const browser = page.browser();
  const viewport = page.viewport();
  const cookies = await page.cookies().catch(() => []);
  console.log(`Recycling the viewer tab to give its memory back; continuing at page ${resumeAt}`);
  const started = Date.now();
  memory.logUsage('before the tab recycle');
  const fresh = await openViewerPage(browser, { cookies });
  if (viewport && (viewport.width !== 1920 || viewport.height !== 1080)) await fresh.setViewport(viewport);
  await page.close().catch(() => {});
  await onPageReplaced(fresh);
  // The old renderer exits a moment after its tab closes; let it go before
  // the fresh one starts to grow.
  await fresh.waitForTimeout(2000);
  memory.logUsage('with the old tab closed');
  try {
    await fresh.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    await dismissCookieBanner(fresh).catch(() => {});
    await fresh.waitForSelector('img.preso-view.page-view', { timeout: 20000 });
  } catch (e) {
    throw new CaptureAborted(`the viewer tab could not be reopened after shedding memory (${e.message})`);
  }
  await prepareDeckViewer(fresh);
  const landed = await jumpToPage(fresh, resumeAt);
  memory.logUsage('after the tab recycle');
  console.log(`Viewer tab recycled in ${Math.round((Date.now() - started) / 1000)}s; viewer on page ${landed}`);
  return fresh;
}

async function capturePages(page, { onCheckpoint = noop, abort = new AbortFlag(), shed = null, onPageReplaced = noop } = {}) {
  abort.check();
  // Branch for vertical DocSend docs — body.vertical is set on portrait/long-form docs
  // where ArrowRight navigation doesn't work and the landscape viewport clips content.
  // Kill switch: set VERTICAL_CAPTURE_LEGACY=1 to force old behavior.
  const isVertical = await page.evaluate(() =>
    document.body && document.body.classList && document.body.classList.contains('vertical')
  );
  if (isVertical && process.env.VERTICAL_CAPTURE_LEGACY !== '1') {
    console.log('Detected vertical DocSend doc');
    return captureVerticalPages(page, { onCheckpoint, abort });
  }

  // Branch for spreadsheets, which render sheet tables in a previews iframe —
  // the slide-deck loop below would only ever see one "page".
  // Kill switch: set SPREADSHEET_CAPTURE_LEGACY=1 to force old behavior.
  if (process.env.SPREADSHEET_CAPTURE_LEGACY !== '1') {
    const spreadsheetFrame = await findSpreadsheetFrame(page);
    if (spreadsheetFrame) {
      return captureSpreadsheetPages(page, spreadsheetFrame, { onCheckpoint, abort });
    }
  }

  console.log('Capturing document pages...');
  await prepareDeckViewer(page);

  await onCheckpoint('capture-ready', { page });
  const screenshots = [];
  let lastPage = null;
  let pageNum = 1;
  while (true) {
    abort.check();
    // The watchdog wants memory back: swap the tab for a fresh one showing the
    // page we are about to capture (only possible when the viewer counts pages).
    if (shed && shed.requested && lastPage !== null) {
      await shed.service(async () => {
        page = await recycleViewerTab(page, { resumeAt: lastPage + 1, onPageReplaced });
        return true;
      });
      abort.check();
    }
    const current = await currentPageNumber(page);
    console.log(`Capturing page ${pageNum} (reported page number ${current})`);

    // Prefer the decoded slide <img> over a viewport screenshot — a full-page
    // screenshot goes white if the slide image hasn't painted yet, which is what
    // produced blank PDF pages. Fall back to a full-page shot only if no slide
    // image is present.
    let shot = await captureSlideImage(page, current, { abort });
    if (!shot) {
      shot = await boundedFullPageScreenshot(page, abort);
      console.log(`  full-page screenshot fallback: ${shot.length} bytes`);
    }

    await onCheckpoint(`capture-page-${pageNum}`, { page, extra: { reportedPageNumber: current, lastPage } });
    // Page counter didn't advance → we already captured this page last
    // iteration; drop the duplicate shot. (Keep the first shot even when the
    // counter is missing so a counter-less viewer still yields one page.)
    if (current === lastPage && screenshots.length > 0) break;
    screenshots.push(shot);
    lastPage = current;
    pageNum++;
    await page.keyboard.press('ArrowRight');
    await waitForViewerIdle(page);
    // Wait for the page counter to advance instead of sleeping a fixed 2s.
    // On the last slide it never advances — the 2s timeout fires once and the
    // duplicate-page check above terminates the loop, same as before.
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('span[aria-label="page number"]');
        return el && parseInt(el.textContent, 10) !== prev;
      },
      { timeout: 2000 },
      current
    ).catch(() => {});
    await page.waitForTimeout(300);
  }
  console.log(`Captured ${screenshots.length} pages`);
  return screenshots;
}

/**
 * A fresh viewer tab with the settings every DocSend page needs (viewport,
 * UA, headers, optional restored session cookies).
 */
async function openViewerPage(browser, { cookies = null } = {}) {
  const page = await browser.newPage();

  await page.setViewport({ width: 1920, height: 1080 });
  await page.setDefaultNavigationTimeout(60000);

  page.on('console', msg => console.log('Browser console:', msg.text()));

  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  // NOTE: extra headers apply to EVERY request (CSS, XHR, images), not just
  // navigations. Forcing Sec-Fetch-*/Accept on subresources makes Chrome
  // reject them (net::ERR_INVALID_ARGUMENT) and the viewer renders unstyled
  // with no page images, so only set headers that are valid everywhere.
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9'
  });

  await page.setBypassCSP(true);
  await page.setJavaScriptEnabled(true);

  if (cookies && cookies.length) {
    await page.setCookie(...cookies).catch(e => console.log('Could not restore cookies:', e.message));
  }

  return page;
}

/**
 * Everything that happens on a classic viewer page after navigation: the
 * email / passcode gates, the email-verification wall, the CCPA banner, then
 * the page capture (with a full-page screenshot as a last resort). Returns the
 * screenshot buffers. parkOnVerificationWall: throw EmailVerificationRequired
 * at the wall (first attempt) instead of a plain error (resume attempt, or a
 * document inside a dataroom whose link has already been used).
 */
async function captureLoadedDocument(page, {
  messageText = '',
  email = process.env.DOCSEND_EMAIL,
  onCheckpoint = noop,
  parkOnVerificationWall = true,
  abort = new AbortFlag(),
  // Memory shedding: the deck loop recycles its tab on request and reports
  // the replacement through onPageReplaced(newPage).
  shed = null,
  onPageReplaced = noop
} = {}) {
  console.log('Waiting for document to be fully loaded...');
  await page.waitForFunction(() => {
    return document.readyState === 'complete' &&
           !document.querySelector('.loading-spinner') &&
           !document.querySelector('.loading');
  }, { timeout: 30000 });
  console.log('Document fully loaded');
  await onCheckpoint('initial-load', { page });

  const passwordMatch = messageText.match(/pw:([^\s]+)/i);
  const docsendPassword = passwordMatch ? passwordMatch[1] : null;

  const loginFrameHandle = await page.$('iframe[src*="docsend"][src*="login"]');
  if (loginFrameHandle) {
    const loginFrame = await loginFrameHandle.contentFrame();
    await onCheckpoint('email-iframe-detected', { page, frame: loginFrame });
    console.log('Email login iframe detected; entering DOCSEND_EMAIL');
    await loginFrame.waitForSelector('input[type="email"]', { timeout: 60000 });
    await requireEmail(page, email);
    // DocSend prefills the field from a remembered session; typing on top of
    // that produces "a@b.coma@b.com" and a failed submit.
    await loginFrame.$eval('input[type="email"]', el => { el.value = ''; }).catch(() => {});
    await loginFrame.type('input[type="email"]', email);
    console.log('Entered email in form');
    await onCheckpoint('email-typed-iframe', { page, frame: loginFrame });

    if (docsendPassword) {
      console.log('Password required and email/password iframe detected; entering password...');
      const passwordSelector = 'input[type="password"]';
      try {
        const passwordField = await loginFrame.waitForSelector(passwordSelector, { timeout: 5000 });
        if (passwordField) {
          await loginFrame.type(passwordSelector, docsendPassword);
          console.log('Entered password in iframe');
          await onCheckpoint('password-typed-iframe', { page, frame: loginFrame });
        } else {
          console.log('Password field not found in email iframe');
        }
      } catch (e) {
        console.log('Error entering password in email iframe:', e.message);
      }
    }

    try {
      await page.evaluate(() => {
        const cookieBanner = document.querySelector('#onetrust-consent-sdk');
        if (cookieBanner) cookieBanner.remove();
      });
      console.log('Removed cookie banner if present');
    } catch (error) {
      console.log('No cookie banner to remove or error removing it:', error);
    }

    await onCheckpoint('before-continue-iframe', { page, frame: loginFrame });

    try {
      console.log('Trying XPath method to find continue button...');
      try {
        const [continueBtn] = await loginFrame.$x("//button[contains(normalize-space(.), 'Continue')]");
        if (continueBtn) {
          await continueBtn.click();
          await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
          console.log('Email and password submitted via iframe (XPath method)');
          await onCheckpoint('continue-clicked-xpath', { page });
        } else {
          console.log('XPath method failed to find button');
          await onCheckpoint('xpath-continue-not-found', { page, frame: loginFrame });

          console.log('Trying alternative button selectors...');
          const alternativeSelectors = [
            "button[type='submit']",
            "button.submit-button",
            "button.continue-button",
            "button.btn-primary",
            "button.primary-button",
            "button:not([disabled])"
          ];

          for (const selector of alternativeSelectors) {
            try {
              console.log(`Trying selector: ${selector}`);
              const button = await loginFrame.$(selector);
              if (button) {
                await button.click();
                await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
                console.log(`Email submitted via iframe using selector: ${selector}`);
                await onCheckpoint(`continue-clicked-alt-${selector.replace(/[^a-z0-9]/gi, '_')}`, { page });
                break;
              }
            } catch (err) {
              console.log(`Error with selector ${selector}:`, err.message);
            }
          }

          try {
            console.log('Trying to press Enter in email field...');
            await loginFrame.focus('input[type="email"]');
            await loginFrame.keyboard.press('Enter');
            await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
            console.log('Pressed Enter in email field');
            await onCheckpoint('continue-pressed-enter', { page });
          } catch (enterErr) {
            console.log('Error pressing Enter:', enterErr.message);
          }
        }
      } catch (xpathError) {
        console.log('XPath method failed:', xpathError);
      }

      await page.waitForTimeout(5000);
    } catch (e) {
      console.log('Failed to click continue button, but proceeding anyway:', e.message);
    }
  } else if (await page.$('input[type="email"], input[name="email"]') !== null) {
    await onCheckpoint('email-inline-detected', { page });
    console.log('Email login detected; entering DOCSEND_EMAIL');
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 60000 });
    await requireEmail(page, email);
    await page.$eval('input[type="email"], input[name="email"]', el => { el.value = ''; }).catch(() => {});
    await page.type('input[type="email"], input[name="email"]', email);
    console.log('Entered email in form');
    await onCheckpoint('email-typed-inline', { page });

    if (docsendPassword) {
      console.log('Password required and email/password form detected; entering password...');
      const passwordSelector = 'input[type="password"]';
      try {
        const passwordField = await page.waitForSelector(passwordSelector, { timeout: 5000 });
        if (passwordField) {
          await page.type(passwordSelector, docsendPassword);
          console.log('Entered password in form');
          await onCheckpoint('password-typed-inline', { page });
        } else {
          console.log('Password field not found on email form');
        }
      } catch (e) {
        console.log('Error entering password on email form:', e.message);
      }
    }

    try {
      await page.evaluate(() => {
        const cookieBanner = document.querySelector('#onetrust-consent-sdk');
        if (cookieBanner) cookieBanner.remove();
      });
      console.log('Removed cookie banner if present');
    } catch (error) {
      console.log('No cookie banner to remove or error removing it:', error);
    }

    await onCheckpoint('before-continue-inline', { page });

    try {
      console.log('Trying XPath method to find continue button...');
      try {
        const [continueBtn] = await page.$x("//button[contains(normalize-space(.), 'Continue')]");
        if (continueBtn) {
          try {
            await continueBtn.click();
          } catch (clickErr) {
            // "Node is either not clickable or not an HTMLElement" — covered/offscreen/re-rendered.
            // DOM-level click sidesteps puppeteer's clickable-point check.
            console.log('Native click failed, falling back to evaluate click:', clickErr.message);
            await continueBtn.evaluate(el => el.click());
          }
          await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
          console.log('Email and password submitted inline (XPath method)');
          await onCheckpoint('continue-clicked-inline', { page });
        } else {
          console.log('XPath method failed to find button');
          await onCheckpoint('xpath-continue-not-found-inline', { page });
        }
      } catch (xpathError) {
        console.log('XPath method failed:', xpathError);
      }

      await page.waitForTimeout(5000);
    } catch (e) {
      console.log('Failed to click continue button, but proceeding anyway:', e.message);
    }
  } else {
    await onCheckpoint('no-email-form', { page });
  }

  const emailRejection = await detectEmailRejection(page);
  if (emailRejection) {
    await onCheckpoint('email-rejected', { page, extra: { reason: emailRejection } });
    console.log(`DocSend rejected the email ${email}: ${emailRejection}`);
    throw new EmailRejected(email, emailRejection, await page.cookies().catch(() => []));
  }

  if (!docsendPassword && await detectPasscodeGate(page)) {
    await onCheckpoint('passcode-gate', { page });
    console.log('Passcode gate detected and no pw: given; asking the caller for it');
    const sessionCookies = await page.cookies().catch(() => []);
    throw new PasscodeRequired(sessionCookies);
  }

  if (docsendPassword) {
    console.log('Password required; using generic password entry workflow...');
    const passInputSelectors = [
      'input[type="password"]',
      'input[name="passcode"]',
      'input[name="password"]',
      'input[name="passCode"]',
      'input[name="pass"]',
      'input[placeholder*="Pass"]',
      'input[placeholder*="pass"]',
      'input[placeholder*="Password"]',
      'input[placeholder*="password"]',
      'input[aria-label*="pass"]',
      'input[aria-label*="Pass"]',
      'input[id*="pass"]',
      'input[id*="Pass"]',
      'input[class*="pass"]',
      'input[class*="Pass"]',
      'input[data-testid*="pass"]',
      'input[data-testid*="Pass"]'
    ];

    let inputFrame = page;
    let passInputHandle = null;
    let foundSelector = null;

    await page.waitForTimeout(3000);

    for (const selector of passInputSelectors) {
      try {
        passInputHandle = await page.waitForSelector(selector, { timeout: 2000 });
        if (passInputHandle) {
          foundSelector = selector;
          console.log(`Found password field in main page with selector: ${selector}`);
          break;
        }
      } catch (e) {}
    }

    if (!passInputHandle) {
      console.log('Password field not found in main page, searching frames...');
      for (const frame of page.frames()) {
        if (passInputHandle) break;
        for (const selector of passInputSelectors) {
          try {
            passInputHandle = await frame.waitForSelector(selector, { timeout: 2000 });
            if (passInputHandle) {
              inputFrame = frame;
              foundSelector = selector;
              console.log(`Found password field in frame with selector: ${selector}`);
              break;
            }
          } catch (e) {}
        }
      }
    }

    if (!passInputHandle) {
      console.log('Trying generic input field search...');
      try {
        const allInputs = await page.$$('input');
        for (const input of allInputs) {
          const inputType = await input.evaluate(el => el.type);
          const inputName = await input.evaluate(el => el.name);
          const inputPlaceholder = await input.evaluate(el => el.placeholder);
          const inputId = await input.evaluate(el => el.id);
          const inputClass = await input.evaluate(el => el.className);

          console.log(`Found input: type=${inputType}, name=${inputName}, placeholder=${inputPlaceholder}, id=${inputId}, class=${inputClass}`);

          if (inputType === 'password' ||
              (inputName && inputName.toLowerCase().includes('pass')) ||
              (inputPlaceholder && inputPlaceholder.toLowerCase().includes('pass')) ||
              (inputId && inputId.toLowerCase().includes('pass')) ||
              (inputClass && inputClass.toLowerCase().includes('pass'))) {
            passInputHandle = input;
            foundSelector = 'generic search';
            console.log('Found password field via generic search');
            break;
          }
        }
      } catch (e) {
        console.log('Generic input search failed:', e);
      }
    }

    if (!passInputHandle) {
      await onCheckpoint('password-field-not-found', { page });
      try {
        const debugShot = await page.screenshot({ fullPage: true });
        console.log('Debug screenshot taken, size:', debugShot.length);
      } catch (e) {
        console.log('Could not take debug screenshot');
      }
      throw new Error('Passcode input field not found after exhaustive search');
    }

    if (foundSelector === 'generic search') {
      await passInputHandle.type(docsendPassword);
    } else {
      await inputFrame.type(foundSelector, docsendPassword);
    }
    console.log('Passcode typed into field');
    await onCheckpoint('passcode-typed', { page });

    const continueXPath = "//button[contains(normalize-space(.), 'Continue')]";
    let clicked = false;
    const [btnMain] = await page.$x(continueXPath);
    if (btnMain) {
      await btnMain.click();
      clicked = true;
    } else {
      for (const frame of page.frames()) {
        const [btnFrame] = await frame.$x(continueXPath);
        if (btnFrame) {
          await btnFrame.click();
          clicked = true;
          break;
        }
      }
    }
    if (!clicked) {
      console.log('Continue button not found after passcode entry');
      await onCheckpoint('passcode-continue-not-found', { page });
    } else {
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {});
      console.log('Passcode submitted');
      await onCheckpoint('passcode-submitted', { page });
      if (await detectPasscodeGate(page)) {
        throw new Error('DocSend rejected the passcode');
      }
    }
  }

  if (await detectEmailVerificationWall(page)) {
    await onCheckpoint('email-verification-wall', { page });
    if (!parkOnVerificationWall) {
      throw new Error('Still asked to verify email after opening the verification link; it may have expired or been used already');
    }
    console.log(`Email verification required; DocSend emailed a link to ${email}`);
    const sessionCookies = await page.cookies().catch(() => []);
    throw new EmailVerificationRequired(email, sessionCookies);
  }

  console.log('Hiding cookie banners and overlays...');
  console.log('Waiting for page to stabilize...');
  await page.waitForTimeout(1500);
  await onCheckpoint('before-ccpa', { page });

  console.log('Looking for CCPA iframe...');
  const ccpaIframeSelectors = [
    '#ccpa-iframe',
    '[data-testid="ccpa-iframe"]',
    'iframe[src*="ccpa"]',
    'iframe[src*="consent"]',
    'iframe[src*="cookie"]'
  ];

  // Single non-blocking pass: the page has already sat through the login flow
  // and a stabilization wait, so any consent iframe is in the DOM by now.
  // (The old retry loop waitForSelector'd 5 selectors × 5s × 10 rounds ≈ 4.5
  // minutes per capture when no banner existed — which is the normal case.)
  let cookieBannerFound = false;
  for (const selector of ccpaIframeSelectors) {
    try {
      const iframeElement = await page.$(selector);
      if (!iframeElement) continue;
      console.log(`Found CCPA iframe with selector: ${selector}`);
      const frame = await iframeElement.contentFrame();
      if (!frame) continue;
      const acceptButton = await frame.$('#accept_all_cookies_button');
      if (!acceptButton) continue;
      const isVisible = await acceptButton.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' &&
               style.visibility !== 'hidden' &&
               style.opacity !== '0' &&
               el.offsetWidth > 0 &&
               el.offsetHeight > 0;
      });
      if (isVisible) {
        try {
          await acceptButton.click();
        } catch (clickError) {
          await acceptButton.evaluate(el => el.click());
        }
        console.log('Clicked CCPA accept button');
        cookieBannerFound = true;
        break;
      }
    } catch (error) {
      console.log(`Error with iframe selector ${selector}:`, error.message);
    }
  }

  if (!cookieBannerFound) {
    console.log('No CCPA iframe found; banner elements are hidden during capture anyway');
  }

  await page.waitForTimeout(500);
  await onCheckpoint('after-ccpa', { page, extra: { cookieBannerFound } });

  console.log('Proceeding to capture document pages');
  abort.check();
  try {
    return await capturePages(page, { onCheckpoint, abort, shed, onPageReplaced });
  } catch (captureError) {
    // An abort is deliberate: no fallback screenshot, the caller handles it.
    if (captureError.code === 'CAPTURE_ABORTED' || abort.aborted) {
      abort.check();
      throw captureError;
    }
    console.error('Error in capturePages:', captureError);
    await onCheckpoint('capture-error', { page, extra: { message: captureError.message } });

    console.log('Attempting fallback screenshot capture...');
    try {
      await page.evaluate(() => {
        const selectors = [
          'header', '.header', '.top-bar', '.presentation-toolbar',
          '.navbar-fixed-bottom', '.bottom-bar', '.presentation-fixed-footer'
        ];
        selectors.forEach(sel =>
          document.querySelectorAll(sel).forEach(el => el.style.display = 'none')
        );
      });

      await dismissCookieBanner(page);

      console.log('Taking fallback screenshot');
      const fallbackShot = await boundedFullPageScreenshot(page, abort);
      return [fallbackShot];
    } catch (fallbackError) {
      console.error('Fallback screenshot also failed:', fallbackError);
      throw new Error('Failed to capture document content');
    }
  }
}

/**
 * DocSend datarooms ("spaces", /view/s/<space>) are a React app
 * (body[data-controller="bundle_presentation"]) rather than the classic
 * viewer: the email gate is a React modal, the folder tree is loaded through
 * a GraphQL endpoint, and each document inside is an ordinary viewer page at
 * /view/<space>/d/<doc> that captureLoadedDocument already handles.
 */
async function isDataroomPage(page) {
  if (/\/view\/s\//.test(page.url())) return true;
  return page.evaluate(() =>
    !!document.body && document.body.dataset.controller === 'bundle_presentation'
  ).catch(() => false);
}

const DATAROOM_MODAL = '.ReactModal__Content[role="dialog"]';

/**
 * The dataroom's "Enter your email to access this content" modal: a React
 * <form> with input#email and a type=submit button ("Confirm", not the
 * classic viewer's "Continue"). Submitting fires the authorize mutation; the
 * modal then closes, or turns into the "Check your email" wall when the
 * owner requires verification. Returns whether a form was found.
 */
async function passDataroomEmailGate(page, { email, docsendPassword, onCheckpoint = noop }) {
  const emailSelector = `${DATAROOM_MODAL} input[type="email"], ${DATAROOM_MODAL} input#email`;
  const emailField = await page.$(emailSelector);
  if (!emailField) {
    await onCheckpoint('dataroom-no-email-form', { page });
    return false;
  }
  await onCheckpoint('dataroom-email-form', { page });
  await requireEmail(page, email);
  console.log('Dataroom email form detected; entering email');
  await emailField.evaluate(el => { el.value = ''; }).catch(() => {});
  await emailField.type(email);

  if (docsendPassword) {
    const passField = await page.$(`${DATAROOM_MODAL} input[type="password"]`);
    if (passField) {
      await passField.type(docsendPassword);
      console.log('Entered passcode in dataroom form');
    }
  }
  await onCheckpoint('dataroom-email-typed', { page });

  const submit = await page.$(`${DATAROOM_MODAL} form button[type="submit"], ${DATAROOM_MODAL} button[type="submit"]`);
  if (submit) {
    await submit.click().catch(() => submit.evaluate(el => el.click()));
  } else {
    console.log('No submit button in dataroom email form; pressing Enter');
    await emailField.press('Enter');
  }
  console.log('Submitted dataroom email form');

  // The modal either goes away (authorized) or swaps its form for the
  // verification wall; either way the email input disappears.
  await page.waitForFunction((sel) => {
    const modal = document.querySelector(sel);
    return !modal || !modal.querySelector('input[type="email"]');
  }, { timeout: 30000 }, DATAROOM_MODAL).catch(() =>
    console.log('Dataroom email form still showing 30s after submit')
  );
  await page.waitForFunction(() =>
    document.readyState === 'complete' && !document.querySelector('.loading-spinner') && !document.querySelector('.loading'),
    { timeout: 30000 }
  ).catch(() => {});
  await page.waitForTimeout(2000);
  await onCheckpoint('dataroom-email-submitted', { page });
  return true;
}

// The same endpoint and operation the dataroom app uses to list a folder;
// the fragments are trimmed to what enumeration needs.
const SPACE_FOLDER_QUERY = `
query spaceFolder($linkUrl: String!, $folderUrl: String, $timezoneOffset: Int!, $accessedFromEmailVerification: Boolean!) {
  spaceFolder(linkUrl: $linkUrl, folderUrl: $folderUrl, timezoneOffset: $timezoneOffset, accessedFromEmailVerification: $accessedFromEmailVerification) {
    authorizedData {
      data {
        name
        href
        url
        space { name }
        contents(first: 200) {
          totalCount
          nodes {
            __typename
            ... on SpaceFolder { name href url archived }
            ... on SpaceDocument { name href url type }
            ... on SpaceFileRequest { name href }
            ... on SpaceSection { name }
          }
        }
      }
    }
    unauthorized { reasons }
  }
}`;

async function fetchSpaceFolder(page, { linkUrl, folderUrl = null }) {
  const accessedFromEmailVerification = /accessed_from_email_verification=true/.test(page.url());
  return page.evaluate(async (query, variables) => {
    const resp = await fetch('/presentation/graphql?op=spaceFolder', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/graphql-response+json, application/json'
      },
      body: JSON.stringify({
        operationName: 'spaceFolder',
        query,
        variables: { ...variables, timezoneOffset: new Date().getTimezoneOffset() }
      })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }, SPACE_FOLDER_QUERY, { linkUrl, folderUrl, accessedFromEmailVerification });
}

/**
 * Walk the dataroom's folder tree through GraphQL. Returns
 * { title, documents: [{ title, url, folder, type }] } with document URLs
 * resolved against the page origin (custom subdomains included).
 */
async function enumerateDataroomViaApi(page, spaceId) {
  const origin = new URL(page.url()).origin;
  const documents = [];
  const seen = new Set();
  let title = null;

  const walk = async (folderUrl, pathNames, depth) => {
    const res = await fetchSpaceFolder(page, { linkUrl: spaceId, folderUrl });
    const spaceFolder = res && res.data && res.data.spaceFolder;
    const data = spaceFolder && spaceFolder.authorizedData && spaceFolder.authorizedData.data;
    if (!data) {
      const reasons = spaceFolder && spaceFolder.unauthorized && spaceFolder.unauthorized.reasons;
      const errors = res && res.errors && res.errors.map(e => e.message).join('; ');
      throw new Error(`spaceFolder query returned no authorized data${folderUrl ? ` for folder ${folderUrl}` : ''}`
        + (reasons ? ` (unauthorized: ${reasons.join(', ')})` : '')
        + (errors ? ` (${errors})` : ''));
    }
    if (!title && data.space && data.space.name) title = data.space.name;
    const contents = data.contents || {};
    const nodes = contents.nodes || [];
    if (contents.totalCount > nodes.length) {
      console.log(`Folder "${pathNames.join(' / ') || '(root)'}" has ${contents.totalCount} entries; only the first ${nodes.length} are listed`);
    }
    for (const node of nodes) {
      const label = [...pathNames, node.name].join(' / ');
      if (node.__typename === 'SpaceFolder') {
        if (node.archived) continue;
        if (depth >= 10) {
          console.log(`Skipping folder "${label}": nesting too deep`);
          continue;
        }
        console.log(`Dataroom folder: ${label}`);
        const subUrl = node.url || (node.href ? node.href.split('/').filter(Boolean).pop() : null);
        try {
          await walk(subUrl, [...pathNames, node.name], depth + 1);
        } catch (e) {
          console.log(`Could not list folder "${label}": ${e.message}`);
        }
      } else if (node.__typename === 'SpaceDocument') {
        if (!node.href || !/\/d\//.test(node.href)) {
          console.log(`Skipping non-document entry "${label}" (${node.type || 'unknown type'}, ${node.href || 'no href'})`);
          continue;
        }
        const docUrl = new URL(node.href, origin).href.split('?')[0];
        if (seen.has(docUrl)) continue;
        seen.add(docUrl);
        documents.push({ title: node.name || docUrl, url: docUrl, folder: pathNames.join(' / '), type: node.type || null });
      }
      // SpaceSection headings and SpaceFileRequest upload slots hold no pages.
    }
  };

  await walk(null, [], 0);
  return { title, documents };
}

/**
 * Fallback when the GraphQL listing is not available: collect the rendered
 * document links (anchors whose href contains /d/) from the page.
 */
async function enumerateDataroomViaDom(page) {
  await page.waitForSelector('a[href*="/d/"]', { timeout: 30000 }).catch(() =>
    console.log('No document links rendered within 30s')
  );
  const origin = new URL(page.url()).origin;
  const links = await page.$$eval('a[href*="/d/"]', els => els.map(a => ({
    href: a.getAttribute('href'),
    text: (a.innerText || a.getAttribute('aria-label') || a.title || '').trim().replace(/\s+/g, ' ')
  })));
  const seen = new Set();
  const documents = [];
  for (const link of links) {
    if (!link.href) continue;
    const docUrl = new URL(link.href, origin).href.split('?')[0];
    if (!/\/view\/[^/]+\/d\//.test(docUrl) || seen.has(docUrl)) continue;
    seen.add(docUrl);
    documents.push({ title: link.text || docUrl, url: docUrl, folder: '', type: null });
  }
  const title = await page.title().catch(() => null);
  return { title, documents };
}

const MEMORY_SKIP_REASON = "too large for this instance's memory";
// How long a shed waits for the deck loop to recycle its tab (the swap itself
// takes about ten seconds: a fresh navigation plus the jump to the page).
const SHED_RECYCLE_WAIT_MS = 30000;

async function convertDataroom(initialBrowser, rootPage, {
  url,
  messageText = '',
  email = process.env.DOCSEND_EMAIL,
  onCheckpoint = noop,
  verifyUrl = null,
  onDocument = null,
  // Resume after a restart: documents before startIndex were already posted.
  startIndex = 0,
  // Called once the session is authorized, with the cookies that re-enter
  // it (the restart state keeps them).
  onSession = null,
  abort = new AbortFlag(),
  watchdog = null,
  // Closes the current browser and returns a fresh one (memory pressure).
  relaunchBrowser = null,
  // Told which tab is being captured (null between documents) so memory
  // shedding can close every other one.
  trackPage = () => {},
  shed = null
}) {
  let browser = initialBrowser;
  const spaceId = (rootPage.url().match(/\/view\/s\/([^/?#]+)/) || url.match(/\/view\/(?:s\/)?([^/?#]+)/) || [])[1];
  const passwordMatch = messageText.match(/pw:([^\s]+)/i);
  const docsendPassword = passwordMatch ? passwordMatch[1] : null;

  await rootPage.waitForFunction(() =>
    document.readyState === 'complete' && !document.querySelector('.loading-spinner') && !document.querySelector('.loading'),
    { timeout: 30000 }
  ).catch(() => {});
  await onCheckpoint('dataroom-initial-load', { page: rootPage });

  await passDataroomEmailGate(rootPage, { email, docsendPassword, onCheckpoint });

  if (await detectEmailVerificationWall(rootPage)) {
    await onCheckpoint('dataroom-email-verification-wall', { page: rootPage });
    if (verifyUrl) {
      throw new Error('Still asked to verify email after opening the verification link; it may have expired or been used already');
    }
    console.log(`Email verification required; DocSend emailed a link to ${email}`);
    const sessionCookies = await rootPage.cookies().catch(() => []);
    throw new EmailVerificationRequired(email, sessionCookies);
  }

  let index;
  try {
    index = await enumerateDataroomViaApi(rootPage, spaceId);
  } catch (apiError) {
    console.log(`GraphQL listing failed (${apiError.message}); scraping document links from the page`);
    index = await enumerateDataroomViaDom(rootPage);
  }
  if (!index.title) index.title = await rootPage.title().catch(() => null);
  const title = (index.title || `DocSend dataroom ${spaceId}`).trim();
  const documents = index.documents;

  console.log(`Dataroom "${title}": ${documents.length} document(s)`);
  documents.forEach((doc, i) =>
    console.log(`  ${i + 1}. ${doc.folder ? `${doc.folder} / ` : ''}${doc.title} -> ${doc.url}`)
  );
  await onCheckpoint('dataroom-index', { page: rootPage, extra: { title, documents } });
  if (documents.length === 0) {
    throw new Error('No documents found in the dataroom');
  }
  if (startIndex > 0) {
    console.log(`Resuming the dataroom at document ${Math.min(startIndex, documents.length) + 1}/${documents.length}`);
  }

  // The authorized session's cookies: every document tab starts from them,
  // which is what lets a relaunched browser (memory pressure) or a restarted
  // bot (crash resume) carry on without another email gate.
  let sessionCookies = await rootPage.cookies().catch(() => []);
  if (onSession) await onSession(sessionCookies);

  // The documents open in their own tabs; the index page is not needed any more.
  await rootPage.close().catch(() => {});

  const reclaimMemory = async (why) => {
    if (!relaunchBrowser) return;
    console.log(`Memory pressure ${why}; closing and relaunching the browser`);
    browser = await relaunchBrowser();
    abort.reset();
    if (watchdog) watchdog.rearm();
  };

  const results = [];
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const docLabel = `${i + 1}/${documents.length}`;
    const base = { title: doc.title, url: doc.url, folder: doc.folder, type: doc.type };
    if (i < startIndex) {
      results.push({ ...base, resumed: true, pages: null });
      continue;
    }
    // Pressure that hit between documents (while the previous PDF was being
    // built and uploaded): start the next one from a fresh browser.
    if (abort.aborted) await reclaimMemory('between documents');

    console.log(`Converting dataroom document ${docLabel}: ${doc.title} (${doc.url})`);
    memory.logUsage(`before document ${docLabel}`);
    const docCheckpoint = (name, args) => onCheckpoint(`doc${i + 1}-${name}`, args);
    let docPage = null;
    try {
      // A web-link entry is an external site, not a document: rendering it
      // and screenshotting the whole page is what blew the memory limit, and
      // the result was never a useful PDF. Hand the link through instead.
      if (doc.type === 'WEB_LINK') {
        console.log(`Dataroom document ${docLabel} is a web link; passing it through without rendering`);
        const linkEntry = { ...base, webLink: true, screenshots: [] };
        if (onDocument) await onDocument(linkEntry, i, documents.length);
        results.push({ ...base, webLink: true, pages: 0 });
        continue;
      }
      docPage = await openViewerPage(browser, { cookies: sessionCookies });
      trackPage(docPage);
      abort.check();
      await docPage.goto(doc.url, { waitUntil: 'networkidle0', timeout: 120000 });
      let screenshots = await captureLoadedDocument(docPage, {
        messageText, email, onCheckpoint: docCheckpoint, parkOnVerificationWall: false, abort, shed,
        onPageReplaced: (p) => { docPage = p; trackPage(p); }
      });
      console.log(`Dataroom document ${docLabel} captured: ${screenshots.length} page(s)`);
      sessionCookies = await docPage.cookies().catch(() => sessionCookies);
      await docPage.close().catch(() => {});
      docPage = null;
      trackPage(null);
      if (onDocument) {
        const pages = screenshots.length;
        await onDocument({ ...base, screenshots }, i, documents.length);
        // The caller has built and posted the PDF: let the page buffers go
        // before the next document starts.
        screenshots = null;
        results.push({ ...base, pages });
      } else {
        results.push({ ...base, screenshots });
      }
    } catch (docError) {
      if (abort.aborted || docError.code === 'CAPTURE_ABORTED') {
        // The document is what pushed the instance to its limit: give it up,
        // get the memory back, and carry on with the rest of the room.
        console.error(`Skipping dataroom document ${docLabel} (${doc.title}): ${abort.reason || docError.message}`);
        if (docPage) await docPage.close().catch(() => {});
        docPage = null;
        await reclaimMemory(`while converting document ${docLabel}`);
        const skipped = { ...base, skipped: true, error: MEMORY_SKIP_REASON };
        results.push(skipped);
        if (onDocument) {
          await onDocument({ ...skipped, screenshots: [] }, i, documents.length).catch(e =>
            console.error('Could not report the skipped document:', e.message));
        }
      } else {
        console.error(`Failed to convert dataroom document ${docLabel} (${doc.title}):`, docError.message);
        results.push({ ...base, error: docError.message });
      }
    } finally {
      // One document tab at a time: the instance has 512MB.
      if (docPage) await docPage.close().catch(() => {});
      trackPage(null);
      memory.logUsage(`after document ${docLabel}`);
    }
  }

  const failed = results.filter(r => r.error && !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log(`Dataroom "${title}" done: ${results.length - failed - skipped} converted, ${failed} failed, ${skipped} skipped for memory`);
  return { dataroom: true, title, url, spaceId, documents: results };
}

async function convertDocSendToPDF(url, messageText, opts = {}) {
  const {
    launchOptions = {},
    onCheckpoint = noop,
    keepOpenOnError = false,
    email = process.env.DOCSEND_EMAIL,
    // Resuming after an email-verification wall: the one-time link DocSend
    // emailed, plus the cookies of the session that requested it (the link
    // may only authorize that session).
    verifyUrl = null,
    cookies = null,
    // Datarooms: called with each converted document ({ title, url, folder,
    // screenshots }) as soon as it is captured, so the caller can build and
    // post its PDF and let the screenshots go instead of holding every
    // document's pages in memory until the end. A document skipped under
    // memory pressure arrives with skipped: true and no screenshots.
    onDocument = null,
    // Datarooms: skip the first startIndex documents (already posted before
    // a restart) and report the authorized session's cookies through
    // onSession(cookies) so the caller can persist them.
    startIndex = 0,
    onSession = null
  } = opts;

  console.log('Starting document capture for:', url);
  if (verifyUrl) console.log('Resuming with verification link');

  // Explicit launchOptions (the debug harness: headful, devtools, slowMo) get
  // a dedicated browser; production conversions share one across the queue.
  const dedicated = Object.keys(launchOptions).length > 0;
  const launch = () => dedicated
    ? puppeteer.launch({ headless: 'new', args: DEFAULT_LAUNCH_ARGS, ...launchOptions })
    : getSharedBrowser();
  let browser;
  let page;

  // The memory watchdog first sheds what it can (every tab but the one being
  // captured, Node's garbage, then the viewer tab itself); if that isn't
  // enough it flags the capture and the loops stop at the next check.
  const abort = new AbortFlag();
  const active = { page: null };
  const shedRequests = new ShedRequests();
  const shed = async ({ threshold }) => {
    // Cheap first: spare tabs and Node's garbage.
    const target = active.page && !active.page.isClosed() ? active.page : null;
    const report = await shedBrowserMemory(browser, target);
    const gc = memory.forceGc();
    const after = memory.usage();
    console.log(`Memory shed: closed ${report.closedPages} spare tab(s), Node GC ${gc ? 'ran' : 'unavailable'}; now ${memory.formatMB(after)}`);
    if (after <= threshold) return;
    // Still high: the viewer keeps a decoded bitmap of every slide it has
    // shown, and only a fresh tab gives those back. The deck loop swaps tabs
    // at its next page boundary and resumes where it was.
    const recycled = await shedRequests.request(SHED_RECYCLE_WAIT_MS);
    console.log(`Memory shed: viewer tab ${recycled ? 'recycled' : 'not recycled (no deck capture in progress)'}; now ${memory.formatMB(memory.usage())}`);
  };
  const watchdog = memory.watch(({ usage, limit }) =>
    abort.abort(`memory pressure: ${memory.formatMB(usage)} of ${memory.formatMB(limit)} in use`), { onShed: shed });
  const relaunchBrowser = async () => {
    active.page = null;
    if (dedicated) {
      if (browser) await browser.close().catch(() => {});
    } else {
      await closeSharedBrowser();
    }
    browser = await launch();
    memory.logUsage('after browser relaunch');
    return browser;
  };

  try {
    memory.logUsage('at job start');
    browser = await launch();
    page = await openViewerPage(browser, { cookies });
    active.page = page;

    if (verifyUrl) {
      console.log('Opening verification link...');
      await page.goto(verifyUrl, { waitUntil: 'networkidle0', timeout: 120000 });
      await onCheckpoint('verify-link-loaded', { page, extra: { landed: page.url() } });
      if (/token_expired=true/.test(page.url())) {
        throw new Error('The verification link has expired or was already used (DocSend returned token_expired=true)');
      }
      // The link authorizes the session but lands wherever DocSend sends it
      // (for a dataroom document that is the dataroom root), so go to the
      // requested document unless we are already on it.
      const samePath = (a, b) => {
        try { return new URL(a).pathname.replace(/\/$/, '') === new URL(b).pathname.replace(/\/$/, ''); }
        catch (_) { return false; }
      };
      if (!samePath(page.url(), url)) {
        console.log(`Verification link landed on ${page.url()}; navigating to the document`);
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
      }
    } else {
      console.log('Navigating to URL...');
      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: 120000
      });
    }
    console.log('Page loaded');

    if (await isDataroomPage(page)) {
      console.log('DocSend dataroom detected at', page.url());
      const room = await convertDataroom(browser, page, {
        url, messageText, email, onCheckpoint, verifyUrl, onDocument,
        startIndex, onSession, abort, watchdog, relaunchBrowser,
        trackPage: (p) => { active.page = p; },
        shed: shedRequests
      });
      memory.logUsage('at job end');
      return room;
    }

    const screenshots = await captureLoadedDocument(page, {
      messageText, email, onCheckpoint, parkOnVerificationWall: !verifyUrl, abort,
      shed: shedRequests,
      onPageReplaced: (p) => { page = p; active.page = p; }
    });
    memory.logUsage('at job end');
    return screenshots;
  } catch (error) {
    if (['EMAIL_VERIFICATION_REQUIRED', 'PASSCODE_REQUIRED', 'EMAIL_REQUIRED', 'EMAIL_REJECTED'].includes(error.code)) {
      throw error;
    }
    if (abort.aborted || error.code === 'CAPTURE_ABORTED') {
      // Give the memory back before the next queued job starts.
      const aborted = error.code === 'CAPTURE_ABORTED' ? error : new CaptureAborted(abort.reason);
      console.error(`Capture aborted: ${aborted.reason}`);
      memory.logUsage('at abort');
      if (!dedicated) await closeSharedBrowser();
      throw aborted;
    }
    console.error('Error capturing document:', error);
    if (page) {
      try {
        await onCheckpoint('fatal-error', { page, extra: { message: error.message, stack: error.stack } });
      } catch (_) {}
    }
    if (keepOpenOnError && browser) {
      console.log('[keep-open] Leaving browser open for inspection. Press Ctrl+C to exit.');
      await new Promise(() => {});
    }
    throw error;
  } finally {
    watchdog.stop();
    if (!keepOpenOnError) {
      if (dedicated && browser) {
        await browser.close().catch(() => {});
      } else if (page) {
        await page.close().catch(() => {});
      }
    }
  }
}

async function createPDFFromScreenshots(screenshots) {
  console.log('Creating PDF from screenshots...');
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setProducer('DocSend Slack Bot');
  pdfDoc.setCreator('DocSend Slack Bot');

  for (let i = 0; i < screenshots.length; i++) {
    console.log(`Processing screenshot ${i + 1} of ${screenshots.length}...`);
    if (!screenshots[i] || !Buffer.isBuffer(screenshots[i]) || screenshots[i].length === 0) {
      throw new Error(`Invalid screenshot buffer for page ${i + 1}`);
    }
    console.log(`Screenshot ${i + 1} buffer size: ${screenshots[i].length} bytes`);

    try {
      // Detect format by magic bytes — screenshots may be JPEG (puppeteer) or
      // PNG (CDN-fetched image) depending on the capture path taken.
      // Copy into a standalone allocation: pdf-lib reads the Buffer's backing
      // ArrayBuffer from offset 0, which for small pooled Buffers is shared
      // memory with a nonzero byteOffset ("SOI not found in JPEG").
      const buf = Uint8Array.from(screenshots[i]);
      const isPng = buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
      const img = isPng
        ? await pdfDoc.embedPng(buf)
        : await pdfDoc.embedJpg(buf);
      console.log(`Successfully loaded ${isPng ? 'PNG' : 'JPEG'} image ${i + 1}, dimensions: ${img.width}x${img.height}`);
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, {
        x: 0,
        y: 0,
        width: img.width,
        height: img.height,
      });
      console.log(`Successfully added page ${i + 1} as ${isPng ? 'PNG' : 'JPEG'}`);
    } catch (error) {
      console.error(`Error processing screenshot ${i + 1}:`, error);
      throw new Error(`Failed to process screenshot ${i + 1}: ${error.message}`);
    }
  }

  console.log('Saving PDF...');
  try {
    const pdfBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false
    });
    const pdfBuffer = Buffer.from(pdfBytes);
    console.log('PDF created successfully, size:', pdfBuffer.length, 'bytes');

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('Generated PDF buffer is invalid or empty');
    }
    if (pdfBuffer.length < 100 || !pdfBuffer.toString('utf8', 0, 5).includes('%PDF-')) {
      throw new Error('Generated PDF buffer does not contain valid PDF data');
    }

    return pdfBuffer;
  } catch (error) {
    console.error('Error saving PDF:', error);
    throw new Error(`Failed to save PDF: ${error.message}`);
  }
}

module.exports = {
  EmailVerificationRequired,
  EmailRequired,
  EmailRejected,
  PasscodeRequired,
  CaptureAborted,
  AbortFlag,
  ShedRequests,
  recycleViewerTab,
  jumpToPage,
  MEMORY_SKIP_REASON,
  convertDocSendToPDF,
  convertDataroom,
  isDataroomPage,
  enumerateDataroomViaApi,
  captureLoadedDocument,
  openViewerPage,
  createPDFFromScreenshots,
  dismissCookieBanner,
  capturePages,
  captureVerticalPages,
  captureSpreadsheetPages,
  captureSlideImage,
  DEFAULT_LAUNCH_ARGS
};
