const puppeteer = require('puppeteer');

// Chrome repeats of --disable-features overwrite each other (the last one
// wins), so every feature to switch off is listed once.
const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests,Translate,BackForwardCache,OptimizationHints,MediaRouter',
  '--disable-site-isolation-trials',
  '--disable-blink-features=AutomationControlled',
  // Fewer helper processes and background services on the 512MB instance.
  // The zygote only exists on Linux (one process fewer there); the rest shut
  // off work nothing in a headless capture needs. --renderer-process-limit was
  // tried and rejected: it makes every tab share one renderer, and closing a
  // tab then gives nothing back.
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-component-update',
  '--disable-sync',
  '--disable-breakpad',
  '--mute-audio',
  '--disk-cache-size=1',
  '--no-first-run',
  '--no-default-browser-check'
];

// One Chromium shared across queued conversions: launching per job cost a
// multi-second startup and a memory spike at the worst moment (job start).
// The queue closes it when it drains so an idle bot isn't holding ~100MB.
let sharedBrowserPromise = null;

async function getSharedBrowser() {
  if (sharedBrowserPromise) {
    const browser = await sharedBrowserPromise.catch(() => null);
    if (browser && browser.isConnected()) return browser;
    sharedBrowserPromise = null;
  }
  console.log('Launching shared browser...');
  sharedBrowserPromise = puppeteer.launch({
    headless: 'new',
    args: DEFAULT_LAUNCH_ARGS
  });
  return sharedBrowserPromise;
}

async function closeSharedBrowser() {
  if (!sharedBrowserPromise) return;
  const browser = await sharedBrowserPromise.catch(() => null);
  sharedBrowserPromise = null;
  if (browser) {
    console.log('Closing shared browser (queue idle)');
    await browser.close().catch(() => {});
  }
}

/**
 * Give memory back without stopping the capture (the watchdog's first
 * stage): close every tab except the one being captured. Chrome's own
 * purge commands (Memory.simulatePressureNotification,
 * Memory.forciblyPurgeJavaScriptMemory) were tried here and dropped: they
 * freed under 10MB and left the page unable to answer Runtime.evaluate.
 * Returns what it did.
 */
async function shedBrowserMemory(browser, keepPage = null) {
  const report = { closedPages: 0 };
  if (!browser || !browser.isConnected()) return report;
  const pages = await browser.pages().catch(() => []);
  for (const page of pages) {
    if (page === keepPage) continue;
    await page.close().catch(() => {});
    report.closedPages++;
  }
  return report;
}

module.exports = { DEFAULT_LAUNCH_ARGS, getSharedBrowser, closeSharedBrowser, shedBrowserMemory };
