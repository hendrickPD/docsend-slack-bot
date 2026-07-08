const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');

const noop = async () => {};

const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-features=BlockInsecurePrivateNetworkRequests',
  '--disable-features=IsolateOrigins',
  '--disable-site-isolation-trials',
  '--disable-blink-features=AutomationControlled'
];

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
  await page.waitForTimeout(3000);

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
    await page.waitForTimeout(2000);
  }
  console.log(`Captured ${screenshots.length} pages`);
  return screenshots;
}

async function convertDocSendToPDF(url, messageText, opts = {}) {
  const {
    launchOptions = {},
    onCheckpoint = noop,
    keepOpenOnError = false,
    email = process.env.DOCSEND_EMAIL
  } = opts;

  console.log('Starting document capture for:', url);

  let browser;
  let page;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: DEFAULT_LAUNCH_ARGS,
      ...launchOptions
    });
    page = await browser.newPage();

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

    console.log('Navigating to URL...');
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 120000
    });
    console.log('Page loaded');

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

    console.log('Hiding cookie banners and overlays...');
    console.log('Waiting for page to stabilize...');
    await page.waitForTimeout(3000);
    await onCheckpoint('before-ccpa', { page });

    console.log('Looking for CCPA iframe...');
    const ccpaIframeSelectors = [
      '#ccpa-iframe',
      '[data-testid="ccpa-iframe"]',
      'iframe[src*="ccpa"]',
      'iframe[src*="consent"]',
      'iframe[src*="cookie"]'
    ];

    let cookieBannerFound = false;
    let retryCount = 0;
    const maxRetries = 10;

    while (!cookieBannerFound && retryCount < maxRetries) {
      await page.waitForTimeout(2000);
      for (const selector of ccpaIframeSelectors) {
        try {
          const iframeElement = await page.waitForSelector(selector, { timeout: 5000 });
          if (iframeElement) {
            console.log(`Found CCPA iframe with selector: ${selector}`);
            const frame = await iframeElement.contentFrame();
            if (frame) {
              console.log('Successfully accessed iframe content');
              try {
                const acceptButton = await frame.waitForSelector('#accept_all_cookies_button', { timeout: 5000 });
                if (acceptButton) {
                  console.log('Found accept button in iframe');
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
                      console.log('Clicked accept button using click() method');
                    } catch (clickError) {
                      console.log('Click method failed, trying evaluate...');
                      await acceptButton.evaluate(el => el.click());
                      console.log('Clicked accept button using evaluate() method');
                    }
                    cookieBannerFound = true;
                    break;
                  }
                }
              } catch (error) {
                console.log('Accept button not found in iframe yet:', error);
              }
            }
          }
        } catch (error) {
          console.log(`Error with iframe selector ${selector}:`, error);
        }
      }

      if (!cookieBannerFound) {
        retryCount++;
        if (retryCount < maxRetries) {
          console.log(`Retry ${retryCount}/${maxRetries} to find CCPA iframe...`);
        }
      }
    }

    if (!cookieBannerFound) {
      console.log('No CCPA iframe or accept button found after all attempts');
    }

    await page.waitForTimeout(2000);
    await onCheckpoint('after-ccpa', { page, extra: { cookieBannerFound, retryCount } });

    console.log('Proceeding to capture document pages');
    try {
      const screenshots = await capturePages(page, { onCheckpoint });
      return screenshots;
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
  } catch (error) {
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
    if (browser && !keepOpenOnError) {
      await browser.close();
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
      const buf = screenshots[i];
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
  convertDocSendToPDF,
  createPDFFromScreenshots,
  dismissCookieBanner,
  capturePages,
  captureVerticalPages,
  captureSlideImage,
  DEFAULT_LAUNCH_ARGS
};
