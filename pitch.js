const puppeteer = require('puppeteer');
const { DEFAULT_LAUNCH_ARGS, getSharedBrowser } = require('./browser');

const noop = async () => {};

// Safety valves: total ArrowRight presses across the deck, and extra presses
// spent flushing build steps on the final slide (where the counter can no
// longer tell us anything).
const MAX_TOTAL_STEPS = 400;
const MAX_LAST_SLIDE_STEPS = 6;

// Pacing. After a press we wait for the slide counter to move (fast when the
// player responds fast) instead of a fixed sleep, then give the transition /
// build animation a short settle before screenshotting. The settle is the
// lever if captures ever show mid-transition frames.
const COUNTER_WAIT_MS = 700;
const STEP_SETTLE_MS = 450;

/**
 * Capture a pitch.com deck (share links like pitch.com/v/<slug>). The player
 * renders slides as live HTML in .player-v2--stage with a "N / M" counter and
 * dash markers per slide. ArrowRight advances one build step at a time; the
 * counter only changes when the deck moves to the next slide. To capture each
 * slide's FINAL state (all build steps played), we screenshot after every
 * press and only commit the previous slide's latest shot when the counter
 * changes. Two identical consecutive shots with no counter change mean the
 * deck is exhausted.
 */
async function convertPitchToPDF(url, messageText, opts = {}) {
  const {
    launchOptions = {},
    onCheckpoint = noop
  } = opts;

  console.log('Starting Pitch deck capture for:', url);

  // Explicit launchOptions get a dedicated browser; production conversions
  // share one across the queue.
  const dedicated = Object.keys(launchOptions).length > 0;
  let browser;
  let page;
  try {
    browser = dedicated
      ? await puppeteer.launch({ headless: 'new', args: DEFAULT_LAUNCH_ARGS, ...launchOptions })
      : await getSharedBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setDefaultNavigationTimeout(60000);
    page.on('console', msg => console.log('Browser console:', msg.text()));
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    console.log('Navigating to URL...');
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForSelector('.player-v2--stage .slide-wrapper', { timeout: 60000 });
    // Let fonts and slide images finish painting.
    await page.waitForTimeout(3000);
    await onCheckpoint('pitch-player-ready', { page });

    const total = await page.evaluate(() => {
      const counter = document.querySelector('.player-v2-chrome-controls-slide-count');
      const m = counter && counter.textContent.match(/\d+\s*\/\s*(\d+)/);
      if (m) return parseInt(m[1], 10);
      return document.querySelectorAll('.player-slideline-new .dash').length || null;
    });
    console.log(`Pitch deck reports ${total || 'unknown'} slides`);

    const readCurrent = () => page.evaluate(() => {
      const counter = document.querySelector('.player-v2-chrome-controls-slide-count');
      const m = counter && counter.textContent.match(/(\d+)\s*\//);
      return m ? parseInt(m[1], 10) : null;
    });

    const stage = await page.$('.player-v2--stage');
    const snap = () => stage.screenshot({ type: 'jpeg', quality: 85 });

    const screenshots = [];
    let current = await readCurrent();
    let latest = await snap();
    let lastSlideSteps = 0;
    let slideStart = Date.now();

    for (let step = 0; step < MAX_TOTAL_STEPS; step++) {
      await page.keyboard.press('ArrowRight');
      // Wait for the counter to move (times out quietly on build steps and on
      // the last slide), then let the transition animation settle.
      await page.waitForFunction((prev) => {
        const counter = document.querySelector('.player-v2-chrome-controls-slide-count');
        const m = counter && counter.textContent.match(/(\d+)\s*\//);
        return m && parseInt(m[1], 10) !== prev;
      }, { timeout: COUNTER_WAIT_MS, polling: 100 }, current).catch(() => {});
      await page.waitForTimeout(STEP_SETTLE_MS);
      const c = await readCurrent();
      const shot = await snap();

      if (c !== current) {
        // Moved to a new slide — commit the previous slide's final state.
        screenshots.push(latest);
        console.log(`Captured slide ${current}${total ? `/${total}` : ''} (${Date.now() - slideStart}ms)`);
        await onCheckpoint(`pitch-slide-${current}`, { page });
        current = c;
        latest = shot;
        lastSlideSteps = 0;
        slideStart = Date.now();
        continue;
      }
      if (shot.equals(latest)) {
        // No counter change and pixels identical — nothing left to play.
        break;
      }
      // Build step within the same slide; keep the newest state.
      latest = shot;
      if (total && current === total) {
        lastSlideSteps++;
        // A continuously-animating final slide never yields identical shots;
        // don't keep pressing forever.
        if (lastSlideSteps >= MAX_LAST_SLIDE_STEPS) break;
      }
    }
    screenshots.push(latest);
    console.log(`Captured slide ${current}${total ? `/${total}` : ''} (${Date.now() - slideStart}ms)`);

    console.log(`Captured ${screenshots.length} Pitch slides`);
    return screenshots;
  } catch (error) {
    console.error('Error capturing Pitch deck:', error);
    throw error;
  } finally {
    if (dedicated && browser) {
      await browser.close();
    } else if (page) {
      await page.close().catch(() => {});
    }
  }
}

module.exports = { convertPitchToPDF };
