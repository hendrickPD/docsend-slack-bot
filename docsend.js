const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { DEFAULT_LAUNCH_ARGS, getSharedBrowser } = require('./browser');

const noop = async () => {};

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
async function captureVerticalPages(page, { onCheckpoint = noop } = {}) {
  console.log('Capturing vertical document pages (per-image strategy)...');
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

    // Strategy 1: re-encode the already-decoded <img> through a canvas. No new
    // network request, so it can't hit expired signed URLs, and it yields the
    // natural-resolution image. Requires --disable-web-security (canvas taint).
    if (info.naturalWidth > 0) {
      try {
        const dataUrl = await img.evaluate(el => {
          const canvas = document.createElement('canvas');
          canvas.width = el.naturalWidth;
          canvas.height = el.naturalHeight;
          canvas.getContext('2d').drawImage(el, 0, 0);
          return canvas.toDataURL('image/jpeg', 0.9);
        });
        shot = Buffer.from(dataUrl.split(',')[1], 'base64');
        console.log(`  canvas re-encode: ${shot.length} bytes`);
      } catch (canvasErr) {
        console.log(`  canvas re-encode failed (${canvasErr.message})`);
      }
    }

    // Strategy 2: fetch the image bytes from its URL in the browser context
    // (session cookies carry).
    if (!shot) {
      try {
        const bytes = await page.evaluate(async (url) => {
          const resp = await fetch(url, { credentials: 'include' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = new Uint8Array(await resp.arrayBuffer());
          return Array.from(buf);
        }, info.src);
        shot = Buffer.from(bytes);
        console.log(`  fetched ${shot.length} bytes from CDN`);
      } catch (fetchErr) {
        console.log(`  direct fetch failed (${fetchErr.message}), falling back to screenshot`);
      }
    }

    // Strategy 3: element screenshot with the viewport grown to fit the whole
    // page image. Chromium paints regions outside the viewport BLACK when
    // screenshotting past it (this is what produced half-black PDF pages), so
    // never capture beyond the viewport — make the viewport big enough instead.
    if (!shot) {
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
      shot = await img.screenshot({ type: 'jpeg', quality: 80 });
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
async function captureSlideImage(page, pageNum) {
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

    // Strategy 1: re-encode the already-decoded <img> through a canvas. No new
    // network request (can't hit expired signed URLs) and yields natural
    // resolution. Requires --disable-web-security for the cross-origin read.
    if (info.naturalWidth > 0) {
      try {
        const dataUrl = await img.evaluate(el => {
          const canvas = document.createElement('canvas');
          canvas.width = el.naturalWidth;
          canvas.height = el.naturalHeight;
          canvas.getContext('2d').drawImage(el, 0, 0);
          return canvas.toDataURL('image/jpeg', 0.9);
        });
        const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
        console.log(`  canvas re-encode: ${buf.length} bytes`);
        return buf;
      } catch (canvasErr) {
        console.log(`  canvas re-encode failed (${canvasErr.message})`);
      }
    }

    // Strategy 2: fetch the image bytes from its URL in the page context
    // (session cookies carry).
    if (info.src) {
      try {
        const bytes = await page.evaluate(async (url) => {
          const resp = await fetch(url, { credentials: 'include' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return Array.from(new Uint8Array(await resp.arrayBuffer()));
        }, info.src);
        const buf = Buffer.from(bytes);
        console.log(`  fetched ${buf.length} bytes from CDN`);
        return buf;
      } catch (fetchErr) {
        console.log(`  direct fetch failed (${fetchErr.message})`);
      }
    }

    // Strategy 3: element screenshot of the slide image itself.
    try {
      const shot = await img.screenshot({ type: 'jpeg', quality: 80 });
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

async function captureSpreadsheetPages(page, frame, { onCheckpoint = noop } = {}) {
  const tabCount = await frame.$$eval('a.tabstrip-link', els => els.length).catch(() => 0);
  console.log(`Spreadsheet preview detected with ${tabCount} sheet tab(s)`);

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
    await page.screenshot({ type: 'jpeg', quality: 30, clip });
    // And occasionally the buffer itself is corrupt; retry once, then skip the
    // sheet rather than poison the whole PDF (createPDFFromScreenshots throws
    // on an invalid image).
    const isValidImage = b => Buffer.isBuffer(b) && b.length > 4 &&
      ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50));
    let shot = await page.screenshot({ type: 'jpeg', quality: 80, clip });
    if (!isValidImage(shot)) {
      console.log('  screenshot buffer invalid; retrying once');
      await page.waitForTimeout(500);
      shot = await page.screenshot({ type: 'jpeg', quality: 80, clip });
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

async function capturePages(page, { onCheckpoint = noop } = {}) {
  // Branch for vertical DocSend docs — body.vertical is set on portrait/long-form docs
  // where ArrowRight navigation doesn't work and the landscape viewport clips content.
  // Kill switch: set VERTICAL_CAPTURE_LEGACY=1 to force old behavior.
  const isVertical = await page.evaluate(() =>
    document.body && document.body.classList && document.body.classList.contains('vertical')
  );
  if (isVertical && process.env.VERTICAL_CAPTURE_LEGACY !== '1') {
    console.log('Detected vertical DocSend doc');
    return captureVerticalPages(page, { onCheckpoint });
  }

  // Branch for spreadsheets, which render sheet tables in a previews iframe —
  // the slide-deck loop below would only ever see one "page".
  // Kill switch: set SPREADSHEET_CAPTURE_LEGACY=1 to force old behavior.
  if (process.env.SPREADSHEET_CAPTURE_LEGACY !== '1') {
    const spreadsheetFrame = await findSpreadsheetFrame(page);
    if (spreadsheetFrame) {
      return captureSpreadsheetPages(page, spreadsheetFrame, { onCheckpoint });
    }
  }

  console.log('Capturing document pages...');
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
  await page.waitForFunction(
    () => !document.querySelector('.loading-spinner') && !document.querySelector('.loading'),
    { timeout: 30000 }
  );
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

  await onCheckpoint('capture-ready', { page });
  const screenshots = [];
  let lastPage = null;
  let pageNum = 1;
  while (true) {
    const current = await page.evaluate(() => {
      const el = document.querySelector('span[aria-label="page number"]');
      return el ? parseInt(el.textContent, 10) : null;
    });
    console.log(`Capturing page ${pageNum} (reported page number ${current})`);

    // Prefer the decoded slide <img> over a viewport screenshot — a full-page
    // screenshot goes white if the slide image hasn't painted yet, which is what
    // produced blank PDF pages. Fall back to a full-page shot only if no slide
    // image is present.
    let shot = await captureSlideImage(page, current);
    if (!shot) {
      shot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
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
    await page.waitForFunction(
      () => !document.querySelector('.loading-spinner') && !document.querySelector('.loading'),
      { timeout: 30000 }
    );
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
  parkOnVerificationWall = true
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
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
      console.log('Passcode submitted');
      await onCheckpoint('passcode-submitted', { page });
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
  try {
    return await capturePages(page, { onCheckpoint });
  } catch (captureError) {
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
      const fallbackShot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
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
  console.log('Dataroom email form detected; entering DOCSEND_EMAIL');
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

async function convertDataroom(browser, rootPage, {
  url,
  messageText = '',
  email = process.env.DOCSEND_EMAIL,
  onCheckpoint = noop,
  verifyUrl = null,
  onDocument = null
}) {
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

  // The documents open in their own tabs (same browser context, so the
  // authorized session cookies carry); the index page is not needed any more.
  await rootPage.close().catch(() => {});

  const results = [];
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const docLabel = `${i + 1}/${documents.length}`;
    console.log(`Converting dataroom document ${docLabel}: ${doc.title} (${doc.url})`);
    const docCheckpoint = (name, args) => onCheckpoint(`doc${i + 1}-${name}`, args);
    let docPage = null;
    try {
      docPage = await openViewerPage(browser);
      await docPage.goto(doc.url, { waitUntil: 'networkidle0', timeout: 120000 });
      const screenshots = await captureLoadedDocument(docPage, {
        messageText, email, onCheckpoint: docCheckpoint, parkOnVerificationWall: false
      });
      console.log(`Dataroom document ${docLabel} captured: ${screenshots.length} page(s)`);
      const converted = { title: doc.title, url: doc.url, folder: doc.folder, type: doc.type, screenshots };
      if (onDocument) {
        await onDocument(converted, i, documents.length);
        // Drop the page buffers once the caller has handled them.
        results.push({ title: doc.title, url: doc.url, folder: doc.folder, type: doc.type, pages: screenshots.length });
      } else {
        results.push(converted);
      }
    } catch (docError) {
      console.error(`Failed to convert dataroom document ${docLabel} (${doc.title}):`, docError.message);
      results.push({ title: doc.title, url: doc.url, folder: doc.folder, type: doc.type, error: docError.message });
    } finally {
      // One document tab at a time: the instance has 512MB.
      if (docPage) await docPage.close().catch(() => {});
    }
  }

  const failed = results.filter(r => r.error).length;
  console.log(`Dataroom "${title}" done: ${results.length - failed} converted, ${failed} failed`);
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
    // document's pages in memory until the end.
    onDocument = null
  } = opts;

  console.log('Starting document capture for:', url);
  if (verifyUrl) console.log('Resuming with verification link');

  // Explicit launchOptions (the debug harness: headful, devtools, slowMo) get
  // a dedicated browser; production conversions share one across the queue.
  const dedicated = Object.keys(launchOptions).length > 0;
  let browser;
  let page;
  try {
    browser = dedicated
      ? await puppeteer.launch({ headless: 'new', args: DEFAULT_LAUNCH_ARGS, ...launchOptions })
      : await getSharedBrowser();
    page = await openViewerPage(browser, { cookies });

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
      return await convertDataroom(browser, page, {
        url, messageText, email, onCheckpoint, verifyUrl, onDocument
      });
    }

    return await captureLoadedDocument(page, {
      messageText, email, onCheckpoint, parkOnVerificationWall: !verifyUrl
    });
  } catch (error) {
    if (error.code === 'EMAIL_VERIFICATION_REQUIRED') {
      throw error;
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
    if (!keepOpenOnError) {
      if (dedicated && browser) {
        await browser.close();
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
