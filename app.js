require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// Initialize Express app
const expressApp = express();

// Add raw body parser middleware
expressApp.use((req, res, next) => {
  req.rawBody = '';
  req.on('data', chunk => {
    req.rawBody += chunk;
  });
  req.on('end', () => {
    try {
      req.body = JSON.parse(req.rawBody);
    } catch (e) {
      req.body = {};
    }
    next();
  });
});

// Add request logging middleware
expressApp.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  next();
});

// Track processed messages to prevent duplicates
const processedMessages = new Set();

// Health check function
async function checkHealth() {
  console.log('Running health check...');
  
  // Check for required environment variables
  const requiredEnvVars = [
    'SLACK_BOT_TOKEN',
    'SLACK_SIGNING_SECRET',
    'DOCSEND_EMAIL',
    'PORT'
  ];
  
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
  
  console.log('Health check passed');
}

// Health check endpoint (handles both GET and HEAD)
expressApp.get('/', (req, res) => {
  res.send('DocSend to PDF Slack Bot is running!');
});
expressApp.head('/', (req, res) => {
  res.status(200).end();
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Verify Slack request signature
const verifySlackRequest = (req) => {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  
  if (!timestamp || !signature) {
    console.log('Missing Slack signature headers');
    return false;
  }
  
  // Verify request is not older than 5 minutes
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
    console.log('Request too old');
    return false;
  }
  
  // Create the signature basestring
  const sigBasestring = `v0:${timestamp}:${req.rawBody || JSON.stringify(req.body)}`;
  
  // Create our signature
  const mySignature = `v0=${crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(sigBasestring)
    .digest('hex')}`;
    
  console.log('Verifying signature:', {
    received: signature,
    computed: mySignature,
    basestring: sigBasestring
  });
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(mySignature)
  );
};

// Function to dismiss cookie banners (simple approach that worked)
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

// Function to convert DocSend to PDF
/**
 * Captures all pages of the DocSend document by hiding UI elements,
 * focusing the page, and iterating with ArrowRight.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Buffer[]>}
 */
async function capturePages(page) {
  console.log('Capturing document pages...');
  // Hide header/footer UI
  await page.evaluate(() => {
    const selectors = [
      'header', '.header', '.top-bar', '.presentation-toolbar',
      '.navbar-fixed-bottom', '.bottom-bar', '.presentation-fixed-footer'
    ];
    selectors.forEach(sel =>
      document.querySelectorAll(sel).forEach(el => el.style.display = 'none')
    );
  });
  // UI hidden; focusing page
  console.log('UI hidden; focusing page');
  const { width, height } = page.viewport();
  await page.mouse.click(width / 2, height / 2);
  // also hide any leftover cookie banners
  await page.evaluate(() => {
    const el = document.querySelector('#onetrust-consent-sdk');
    if (el) el.style.display = 'none';
  });
  // Allow late-loading UI (cookie banners, etc.) to appear
  await page.waitForFunction(
    () => !document.querySelector('.loading-spinner') && !document.querySelector('.loading'),
    { timeout: 30000 }
  );
  await page.waitForTimeout(3000);
  const screenshots = [];
  let lastPage = null;
  let pageNum = 1;
  while (true) {
    console.log(`Taking screenshot of page ${pageNum}`);
    const shot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 80 });
    screenshots.push(shot);
    const current = await page.evaluate(() => {
      const el = document.querySelector('span[aria-label="page number"]');
      return el ? parseInt(el.textContent, 10) : null;
    });
    if (current === lastPage) break;
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

async function convertDocSendToPDF(url, messageText) {
  console.log('Starting document capture for:', url);
  
  let browser;
  try {
    browser = await puppeteer.launch({
    headless: 'new',
    args: [
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
    ]
  });
    const page = await browser.newPage();
    
    // Set viewport to ensure proper rendering
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set a longer timeout for navigation
    await page.setDefaultNavigationTimeout(60000);
    
    // Enable console logging
    page.on('console', msg => console.log('Browser console:', msg.text()));
    
    // Set a realistic user agent and additional headers
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    });
    
    // Bypass CSP
    await page.setBypassCSP(true);
    
    // Set JavaScript enabled
    await page.setJavaScriptEnabled(true);
    
    // Navigate to the URL
    console.log('Navigating to URL...');
    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 120000 // Increase timeout to 2 minutes
    });
    
    console.log('Page loaded');
    
    // Wait for document to be fully loaded
    console.log('Waiting for document to be fully loaded...');
    await page.waitForFunction(() => {
      return document.readyState === 'complete' && 
             !document.querySelector('.loading-spinner') &&
             !document.querySelector('.loading');
    }, { timeout: 30000 });
    console.log('Document fully loaded');
    
    // Restore generic email and passcode handling
    const passwordMatch = messageText.match(/pw:([^\s]+)/i);
    const docsendPassword = passwordMatch ? passwordMatch[1] : null;
    let passwordAlreadyHandled = false;

    // Handle email entry in login iframe or inline form
    const loginFrameHandle = await page.$('iframe[src*="docsend"][src*="login"]');
    if (loginFrameHandle) {
      const loginFrame = await loginFrameHandle.contentFrame();
      console.log('Email login iframe detected; entering DOCSEND_EMAIL');
      await loginFrame.waitForSelector('input[type="email"]', { timeout: 60000 });
      await loginFrame.type('input[type="email"]', process.env.DOCSEND_EMAIL);
      console.log('Entered email in form');
      
      // Check if password field is also present in the iframe
      if (docsendPassword) {
        console.log('Password required and email/password iframe detected; entering password...');
        
        // Simple password field selector since it's in the same iframe as email
        const passwordSelector = 'input[type="password"]';
        
        try {
          const passwordField = await loginFrame.waitForSelector(passwordSelector, { timeout: 5000 });
          if (passwordField) {
            await loginFrame.type(passwordSelector, docsendPassword);
            console.log('Entered password in iframe');
          } else {
            console.log('Password field not found in email iframe');
          }
        } catch (e) {
          console.log('Error entering password in email iframe:', e.message);
        }
      }
      
      // Handle cookie banner and overlays (simple approach first)
      try {
        await page.evaluate(() => {
          const cookieBanner = document.querySelector('#onetrust-consent-sdk');
          if (cookieBanner) cookieBanner.remove();
        });
        console.log('Removed cookie banner if present');
      } catch (error) {
        console.log('No cookie banner to remove or error removing it:', error);
      }
      
      // Try to find and click continue button using various methods
      try {
        // Try XPath method
        console.log('Trying XPath method to find continue button...');
        try {
          const [continueBtn] = await loginFrame.$x("//button[contains(normalize-space(.), 'Continue')]");
          if (continueBtn) {
            await continueBtn.click();
            await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
            console.log('Email and password submitted via iframe (XPath method)');
          } else {
            console.log('XPath method failed to find button');
            
            // Try alternative selectors
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
                  break;
                }
              } catch (err) {
                console.log(`Error with selector ${selector}:`, err.message);
              }
            }
            
            // As a last resort, try pressing Enter in the email field
            try {
              console.log('Trying to press Enter in email field...');
              await loginFrame.focus('input[type="email"]');
              await loginFrame.keyboard.press('Enter');
              await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
              console.log('Pressed Enter in email field');
            } catch (enterErr) {
              console.log('Error pressing Enter:', enterErr.message);
            }
          }
        } catch (xpathError) {
          console.log('XPath method failed:', xpathError);
        }
        
        // Wait for navigation regardless of button click success
        await page.waitForTimeout(5000);
      } catch (e) {
        console.log('Failed to click continue button, but proceeding anyway:', e.message);
      }
    } else if (await page.$('input[type="email"], input[name="email"]') !== null) {
      console.log('Email login detected; entering DOCSEND_EMAIL');
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 60000 });
      await page.type('input[type="email"], input[name="email"]', process.env.DOCSEND_EMAIL);
      console.log('Entered email in form');
      
      // Check if password field is also present on the same form
      if (docsendPassword) {
        console.log('Password required and email/password form detected; entering password...');
        
        // Simple password field selector since it's on the same form as email
        const passwordSelector = 'input[type="password"]';
        
        try {
          const passwordField = await page.waitForSelector(passwordSelector, { timeout: 5000 });
          if (passwordField) {
            await page.type(passwordSelector, docsendPassword);
            console.log('Entered password in form');
          } else {
            console.log('Password field not found on email form');
          }
        } catch (e) {
          console.log('Error entering password on email form:', e.message);
        }
      }
      
      // Handle cookie banner and overlays (simple approach first)
      try {
        await page.evaluate(() => {
          const cookieBanner = document.querySelector('#onetrust-consent-sdk');
          if (cookieBanner) cookieBanner.remove();
        });
        console.log('Removed cookie banner if present');
      } catch (error) {
        console.log('No cookie banner to remove or error removing it:', error);
      }
      
      // Try to find and click continue button using various methods
      try {
        // Try XPath method
        console.log('Trying XPath method to find continue button...');
        try {
          const [continueBtn] = await page.$x("//button[contains(normalize-space(.), 'Continue')]");
          if (continueBtn) {
            await continueBtn.click();
            await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
            console.log('Email and password submitted inline (XPath method)');
          } else {
            console.log('XPath method failed to find button');
          }
        } catch (xpathError) {
          console.log('XPath method failed:', xpathError);
        }
        
        // Wait for navigation regardless of button click success
        await page.waitForTimeout(5000);
      } catch (e) {
        console.log('Failed to click continue button, but proceeding anyway:', e.message);
      }
    }

    // Handle DocSend passcode entry using robust search across page and iframes
    if (docsendPassword) {
      console.log('Password required; using generic password entry workflow...');
      
      // More comprehensive selectors for password fields
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
      
      // Wait a bit longer for dynamic content to load
      await page.waitForTimeout(3000);
      
      // Try each selector in the main page first
      for (const selector of passInputSelectors) {
        try {
          passInputHandle = await page.waitForSelector(selector, { timeout: 2000 });
          if (passInputHandle) {
            foundSelector = selector;
            console.log(`Found password field in main page with selector: ${selector}`);
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }
      
      // If not found in main page, search in all frames
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
            } catch (e) {
              // Continue to next selector/frame
            }
          }
        }
      }
      
      // If still not found, try a more generic approach
      if (!passInputHandle) {
        console.log('Trying generic input field search...');
        try {
          // Look for any input field that might be for password
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
        // Take a screenshot for debugging
        try {
          const debugShot = await page.screenshot({ fullPage: true });
          console.log('Debug screenshot taken, size:', debugShot.length);
        } catch (e) {
          console.log('Could not take debug screenshot');
        }
        throw new Error('Passcode input field not found after exhaustive search');
      }
      // Type the password using the found element
      if (foundSelector === 'generic search') {
        // For generic search, we have the element handle directly
        await passInputHandle.type(docsendPassword);
      } else {
        // For selector-based search, use the selector
        await inputFrame.type(foundSelector, docsendPassword);
      }
      console.log('Passcode typed into field');
      // Click Continue button via XPath in page or frames
      const continueXPath = "//button[contains(normalize-space(.), 'Continue')]";
      let clicked = false;
      // Try main page
      const [btnMain] = await page.$x(continueXPath);
      if (btnMain) {
        await btnMain.click();
        clicked = true;
      } else {
        // Try frames
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
      } else {
        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 });
        console.log('Passcode submitted');
      }
    }
    
    // Hide cookie banners and overlays (comprehensive CCPA iframe handling)
    console.log('Hiding cookie banners and overlays...');
    
    // Wait for the page to stabilize and any dynamic content to load
    console.log('Waiting for page to stabilize...');
    await page.waitForTimeout(3000);
    
    // First try to find and interact with the CCPA iframe
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
      // Wait for any dynamic content to load
      await page.waitForTimeout(2000);
      
      // Try to find the CCPA iframe
      for (const selector of ccpaIframeSelectors) {
        try {
          // Wait for the iframe to be present in the DOM
          const iframeElement = await page.waitForSelector(selector, { timeout: 5000 });
          if (iframeElement) {
            console.log(`Found CCPA iframe with selector: ${selector}`);
            
            // Get the iframe's content frame
            const frame = await iframeElement.contentFrame();
            if (frame) {
              console.log('Successfully accessed iframe content');
              
              // Wait for the accept button to be present in the iframe
              try {
                const acceptButton = await frame.waitForSelector('#accept_all_cookies_button', { timeout: 5000 });
                if (acceptButton) {
                  console.log('Found accept button in iframe');
                  
                  // Ensure button is visible and clickable
                  const isVisible = await acceptButton.evaluate(el => {
                    const style = window.getComputedStyle(el);
                    return style.display !== 'none' && 
                           style.visibility !== 'hidden' && 
                           style.opacity !== '0' &&
                           el.offsetWidth > 0 &&
                           el.offsetHeight > 0;
                  });
                  
                  if (isVisible) {
                    // Try to click the button using different methods
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
    
    // Wait for any cookie-related changes to take effect
    await page.waitForTimeout(2000);
    
    console.log('Proceeding to capture document pages');
    try {
      const screenshots = await capturePages(page);
      return screenshots;
    } catch (captureError) {
      console.error('Error in capturePages:', captureError);
      
      // Fallback: try to take a single screenshot of the current page
      console.log('Attempting fallback screenshot capture...');
      try {
        // Hide any UI elements that might be in the way
        await page.evaluate(() => {
          const selectors = [
            'header', '.header', '.top-bar', '.presentation-toolbar',
            '.navbar-fixed-bottom', '.bottom-bar', '.presentation-fixed-footer'
          ];
          selectors.forEach(sel =>
            document.querySelectorAll(sel).forEach(el => el.style.display = 'none')
          );
        });
        
        // Dismiss any cookie banners
        await dismissCookieBanner(page);
        
        // Take a screenshot of whatever is currently visible
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
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Function to convert screenshots to PDF
async function createPDFFromScreenshots(screenshots) {
  console.log('Creating PDF from screenshots...');
  const pdfDoc = await PDFDocument.create();
  
  // Set PDF compression options
  pdfDoc.setProducer('DocSend Slack Bot');
  pdfDoc.setCreator('DocSend Slack Bot');
  
  for (let i = 0; i < screenshots.length; i++) {
    console.log(`Processing screenshot ${i + 1} of ${screenshots.length}...`);
    
    // Validate screenshot buffer
    if (!screenshots[i] || !Buffer.isBuffer(screenshots[i]) || screenshots[i].length === 0) {
      throw new Error(`Invalid screenshot buffer for page ${i + 1}`);
    }
    console.log(`Screenshot ${i + 1} buffer size: ${screenshots[i].length} bytes`);
    
    try {
      // Load the JPEG image
      const jpegImage = await pdfDoc.embedJpg(screenshots[i]);
      console.log(`Successfully loaded JPEG image ${i + 1}, dimensions: ${jpegImage.width}x${jpegImage.height}`);
      
      // Add a new page with the same dimensions as the image
      const page = pdfDoc.addPage([jpegImage.width, jpegImage.height]);
      
      // Draw the image on the page
      page.drawImage(jpegImage, {
        x: 0,
        y: 0,
        width: jpegImage.width,
        height: jpegImage.height,
      });
      
      console.log(`Successfully added page ${i + 1} as JPEG`);
    } catch (error) {
      console.error(`Error processing screenshot ${i + 1}:`, error);
      throw new Error(`Failed to process screenshot ${i + 1}: ${error.message}`);
    }
  }
  
  console.log('Saving PDF...');
  try {
    // Save with compression options
    const pdfBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false
    });
    const pdfBuffer = Buffer.from(pdfBytes);  // Convert Uint8Array to Buffer
    
    console.log('PDF created successfully, size:', pdfBuffer.length, 'bytes');
    
    // Validate PDF buffer
    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('Generated PDF buffer is invalid or empty');
    }
    
    // Additional validation - check if it's a valid PDF
    if (pdfBuffer.length < 100 || !pdfBuffer.toString('utf8', 0, 5).includes('%PDF-')) {
      throw new Error('Generated PDF buffer does not contain valid PDF data');
    }
    
    return pdfBuffer;
  } catch (error) {
    console.error('Error saving PDF:', error);
    throw new Error(`Failed to save PDF: ${error.message}`);
  }
}

// Handle Slack events directly
expressApp.post('/slack/events', (req, res) => {
  console.log('Received Slack event:', JSON.stringify(req.body));
  
  // Verify request signature
  if (!verifySlackRequest(req)) {
    console.log('Invalid request signature');
    res.status(401).send('Invalid request signature');
    return;
  }
  
  // Handle Slack's challenge verification
  if (req.body.type === 'url_verification') {
    console.log('Handling challenge verification');
    res.set('Content-Type', 'text/plain');
    res.send(req.body.challenge);
    return;
  }
  
  // Handle other events
  console.log('Processing regular event');
  
  // Acknowledge the event immediately
  res.status(200).send();
  
  // Process the event asynchronously
  if (req.body.event) {
    const event = req.body.event;
    
    // Handle different message types
    if (event.type === 'message') {
      let messageText = '';
      let messageId = '';
      
      // Get message text and ID based on event type
      if (event.subtype === 'message_deleted') {
        messageText = event.previous_message?.text || '';
        messageId = event.previous_message?.client_msg_id || '';
      } else if (event.subtype === 'message_changed') {
        messageText = event.message?.text || '';
        messageId = event.message?.client_msg_id || '';
      } else {
        messageText = event.text || '';
        messageId = event.client_msg_id || '';
      }
      
      // Check if the message contains a DocSend link
      if (messageText && messageText.includes('docsend.com')) {
        console.log('Found DocSend link:', messageText);
        
        // Extract DocSend URL (handle both /view/ and /v/ formats, with or without angle brackets)
        const docsendUrl = messageText.match(/<?(https:\/\/docsend\.com\/(?:view\/|v\/)[a-zA-Z0-9]+(?:\/[a-zA-Z0-9\-]+)?)>?/)?.[1];
        if (docsendUrl) {
          console.log('Extracted DocSend URL:', docsendUrl);
          
          // Extract document ID from URL (handle both /view/ and /v/ formats)
          const docId = docsendUrl.includes('/view/') 
            ? docsendUrl.split('/view/')[1].split('/')[0]
            : docsendUrl.split('/v/')[1].split('/')[0];
          console.log('Extracted document ID:', docId);
          
          // Create a unique key for this message
          const messageKey = `${messageId}_${docsendUrl}`;
          
          // Check if we've already processed this message
          if (processedMessages.has(messageKey)) {
            console.log('Message already processed, skipping:', messageKey);
            return;
          }
          
          // Mark this message as processed
          processedMessages.add(messageKey);
          
          // Send initial response
          app.client.chat.postMessage({
            channel: event.channel,
            text: `Converting DocSend document to PDF...`,
            thread_ts: event.thread_ts || event.ts
          }).catch(console.error);
          
          // Convert to screenshots and create PDF
          convertDocSendToPDF(docsendUrl, messageText)
            .then(async (screenshots) => {
              if (!screenshots || !Array.isArray(screenshots)) {
                throw new Error('No screenshots returned from convertDocSendToPDF');
              }
              console.log(`Captured ${screenshots.length} pages, creating PDF...`);
              
              // Create PDF from screenshots
              const pdfBuffer = await createPDFFromScreenshots(screenshots);
              
              // Verify PDF buffer is valid
              if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
                throw new Error('Invalid PDF buffer generated');
              }
              
              console.log('PDF buffer size:', pdfBuffer.length, 'bytes');
              
              // Upload PDF to Slack using the newer uploadV2 method
              try {
                const result = await app.client.files.uploadV2({
                  channel_id: event.channel,
                  file: pdfBuffer,
                  filename: `${docId}.pdf`,
                  title: `DocSend Document ${docId}`,
                  thread_ts: event.thread_ts || event.ts,
                  initial_comment: 'Here is your DocSend document converted to PDF.'
                });
                
                console.log('PDF uploaded successfully:', {
                  file_id: result.file?.id,
                  permalink: result.file?.permalink,
                  size: result.file?.size
                });
              } catch (uploadError) {
                console.error('Error uploading PDF:', uploadError);
                throw new Error(`Failed to upload PDF: ${uploadError.message}`);
              }
            })
            .catch(async (error) => {
              console.error('Error processing DocSend:', error);
              
              // Use a generic error message instead of showing the specific error
              await app.client.chat.postMessage({
                channel: event.channel,
                text: `Sorry, I couldn't convert the DocSend document. It might require special access or have security restrictions.`,
                thread_ts: event.thread_ts || event.ts
              });
            });
        }
      }
    }
  }
});

// Start the Express server
(async () => {
  try {
    // Run health check
    try {
      await checkHealth();
    } catch (healthError) {
      console.error('Health check failed but continuing anyway:', healthError);
    }
    
    // Start Express server
    expressApp.listen(process.env.PORT, () => {
      console.log(`Server is running on port ${process.env.PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})();

// Start the Slack app
app.start().then(() => {
  console.log('Slack app is running!');
}).catch((error) => {
  console.error('Error starting Slack app:', error);
}); 