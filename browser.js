const puppeteer = require('puppeteer');

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

module.exports = { DEFAULT_LAUNCH_ARGS, getSharedBrowser, closeSharedBrowser };
