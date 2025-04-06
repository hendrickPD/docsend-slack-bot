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

// Function to convert DocSend to PDF
async function convertDocSendToPDF(url) {
  console.log('Starting document capture for:', url);
  
  const browser = await puppeteer.launch({
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
  
  try {
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
    
    // Navigate to the DocSend URL
    console.log('Navigating to URL...');
    await page.goto(url, { 
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: 60000
    });
    
    // Wait for a short time to let the page load
    await page.waitForTimeout(5000);
    
    // Check for email input form
    console.log('Checking for email form...');
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="Email" i]',
      'form input[type="text"]',
      'input[type="text"]'
    ];
    
    // Wait for iframes to load
    console.log('Waiting for iframes to load...');
    await page.waitForTimeout(5000);
    
    // Get all frames
    const frames = page.frames();
    console.log(`Found ${frames.length} frames`);
    
    // Find the frame containing the email form
    let targetFrame = null;
    for (const frame of frames) {
      try {
        console.log('Checking frame:', frame.url());
        
        // Check if this frame has the email form
        for (const selector of emailSelectors) {
          try {
            const element = await frame.$(selector);
            if (element) {
              console.log('Found email form in frame with selector:', selector);
              targetFrame = frame;
              break;
            }
          } catch (error) {
            console.log('Error checking selector in frame:', error);
          }
        }
        
        if (targetFrame) break;
      } catch (error) {
        console.log('Error checking frame:', error);
      }
    }
    
    if (!targetFrame) {
      // If no frame found, try main page
      console.log('No frame found, checking main page...');
      for (const selector of emailSelectors) {
        const element = await page.$(selector);
        if (element) {
          console.log('Found email form in main page with selector:', selector);
          targetFrame = page;
          break;
        }
      }
    }
    
    if (!targetFrame) {
      throw new Error('Could not find email form in any frame or main page');
    }
    
    // Get email from environment variable
    const docsendEmail = process.env.DOCSEND_EMAIL;
    if (!docsendEmail) {
      throw new Error('DOCSEND_EMAIL environment variable is not set');
    }
    
    // Enter email and submit form
    try {
      // Wait for and fill email input
      await targetFrame.waitForSelector('input[type="email"]', { timeout: 10000 });
      await targetFrame.type('input[type="email"]', docsendEmail);
      console.log('Entered email in form');
      
      // Hide cookie banners and overlays
      console.log('Hiding cookie banners and overlays...');
      
      // Wait for the page to stabilize and any dynamic content to load
      console.log('Waiting for page to stabilize...');
      await page.waitForTimeout(3000); // Increased initial wait time
      
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
      const maxRetries = 10; // Increased retries
      
      while (!cookieBannerFound && retryCount < maxRetries) {
        // Wait for any dynamic content to load
        await page.waitForTimeout(2000); // Increased wait time between retries
        
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
      
      // Try finding button by text using XPath first
      console.log('Trying to find button by text using XPath...');
      const buttonTexts = [
        'Continue',
        'Submit',
        'View Document',
        'Access Document',
        'View',
        'Access',
        'Proceed',
        'Next',
        'Go'
      ];
      
      let buttonFound = false;
      for (const text of buttonTexts) {
        try {
          const [button] = await targetFrame.$x(`//button[contains(., '${text}')] | //input[@type='submit' and contains(@value, '${text}')]`);
          if (button) {
            console.log(`Found button with text: ${text}`);
            
            // Scroll button into view
            await targetFrame.evaluate(el => {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, button);
            
            // Try multiple click methods
            try {
              await button.click();
              console.log('Clicked button using click()');
              buttonFound = true;
              break;
            } catch (e) {
              console.log('Click() failed, trying dispatchEvent...');
              await targetFrame.evaluate(el => {
                el.dispatchEvent(new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  view: window
                }));
              }, button);
              console.log('Clicked button using dispatchEvent');
              buttonFound = true;
              break;
            }
          }
        } catch (error) {
          console.log(`No button found with text: ${text}`);
        }
      }
      
      // If XPath search failed, try CSS selectors
      if (!buttonFound) {
        console.log('XPath search failed, trying CSS selectors...');
        const buttonSelectors = [
          'button[class*="continue"]',
          'button[type="submit"]',
          'input[type="submit"]',
          'button[class*="submit"]',
          'input[class*="submit"]',
          'button[class*="button"]',
          'input[class*="button"]',
          'button[class*="btn"]',
          'input[class*="btn"]',
          'button[class*="primary"]',
          'input[class*="primary"]',
          'button[class*="action"]',
          'input[class*="action"]',
          // Add more specific DocSend selectors
          'button[class*="docsend"]',
          'button[class*="viewer"]',
          'button[class*="document"]',
          'button[class*="access"]',
          'button[class*="proceed"]',
          'button[class*="next"]',
          'button[class*="go"]',
          // Add data attributes
          'button[data-testid*="submit"]',
          'button[data-testid*="continue"]',
          'button[data-testid*="view"]',
          'button[data-testid*="access"]',
          'button[data-testid*="proceed"]',
          'button[data-testid*="next"]',
          'button[data-testid*="go"]'
        ];
        
        for (const selector of buttonSelectors) {
          try {
            console.log(`Checking for button with selector: ${selector}`);
            
            // Wait for button to be visible
            await targetFrame.waitForSelector(selector, { 
              visible: true,
              timeout: 10000 
            });
            console.log(`Found visible button with selector: ${selector}`);
            
            // Wait for button to be enabled
            await targetFrame.waitForFunction(
              (sel) => {
                const button = document.querySelector(sel);
                return button && !button.disabled;
              },
              { timeout: 10000 },
              selector
            );
            console.log(`Button is enabled: ${selector}`);
            
            // Scroll button into view and click
            const clicked = await targetFrame.evaluate((sel) => {
              const button = document.querySelector(sel);
              if (button) {
                // Scroll into view
                button.scrollIntoView({ behavior: 'smooth', block: 'center' });
                
                // Try multiple click methods
                try {
                  button.click();
                  console.log('Clicked button using click()');
                  return true;
                } catch (e) {
                  console.log('Click() failed, trying dispatchEvent...');
                  button.dispatchEvent(new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                  }));
                  console.log('Clicked button using dispatchEvent');
                  return true;
                }
              }
              return false;
            }, selector);
            
            if (clicked) {
              console.log(`Successfully clicked button with selector: ${selector}`);
              buttonFound = true;
              break;
            }
          } catch (error) {
            console.log(`Button not found or not clickable with selector: ${selector}`, error);
          }
        }
      }
      
      if (!buttonFound) {
        throw new Error('Could not find or click any submit button');
      }
      
      // Wait for navigation or content change
      console.log('Waiting for page navigation or content change...');
      try {
        await page.waitForNavigation({ 
          waitUntil: ['networkidle0', 'domcontentloaded'],
          timeout: 60000 
        });
        console.log('Page navigation detected');
      } catch (error) {
        console.log('No navigation detected, waiting for content change...');
        // If no navigation, wait for content to change
        await page.waitForFunction(
          () => {
            const contentSelectors = [
              'iframe[src*="docsend"]',
              'div[class*="viewer"]',
              'div[class*="document"]',
              'div[class*="content"]'
            ];
            return contentSelectors.some(selector => document.querySelector(selector));
          },
          { timeout: 60000 }
        );
        console.log('Content change detected');
      }
      
      // Wait a bit for any dynamic content to load
      await page.waitForTimeout(5000);
      
      // Check for direct PDF link
      console.log('Checking for direct PDF link...');
      const directPdfLink = await page.evaluate(() => {
        // Look for various types of PDF download links
        const selectors = [
          'a[href$=".pdf"]',
          'a[download]',
          'a[href*="download"]',
          'a[href*="pdf"]',
          'button[onclick*="download"]',
          'button[onclick*="pdf"]'
        ];
        
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element) {
            // For buttons, try to get the download URL from onclick handler
            if (element.tagName.toLowerCase() === 'button' && element.onclick) {
              const onclickText = element.onclick.toString();
              const urlMatch = onclickText.match(/['"](https?:\/\/[^'"]+)['"]/);
              if (urlMatch) {
                return urlMatch[1];
              }
            }
            // For links, get the href
            return element.href || element.getAttribute('href');
          }
        }
        return null;
      });
      
      if (directPdfLink) {
        console.log('Direct PDF link found:', directPdfLink);
        
        // Download the PDF using node-fetch
        const fetch = require('node-fetch');
        try {
          const response = await fetch(directPdfLink, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Bot/1.0)',
              'Accept': 'application/pdf,application/x-pdf,application/octet-stream',
              'Referer': url
            }
          });
          
          if (!response.ok) {
            throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
          }
          
          const pdfBuffer = await response.buffer();
          console.log('Direct PDF download successful, size:', pdfBuffer.length, 'bytes');
          
          // Verify PDF buffer is valid
          if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
            throw new Error('Invalid PDF buffer downloaded');
          }
          
          return pdfBuffer;
        } catch (downloadError) {
          console.error('Error downloading PDF directly:', downloadError);
          console.log('Falling back to screenshot capture...');
        }
      } else {
        console.log('No direct PDF link found, proceeding with screenshot capture');
      }
      
      // Continue with screenshot capture if direct download failed or not available
      console.log('Capturing document pages...');
      const screenshots = [];
      
      // Document has multiple pages
      let pageNumber = 1;
      let hasNextPage = true;
      
      while (hasNextPage) {
        console.log(`Capturing page ${pageNumber}...`);
        
        // Click center of page to ensure focus
        const viewport = await page.viewport();
        const centerX = viewport.width / 2;
        const centerY = viewport.height / 2;
        await page.mouse.click(centerX, centerY);
        console.log('Clicked center of page for focus');
        
        // Take screenshot of current page
        const screenshot = await page.screenshot({
          fullPage: true,
          type: 'png',
          encoding: 'binary'
        });
        
        // Verify screenshot is valid
        if (!screenshot || !Buffer.isBuffer(screenshot) || screenshot.length === 0) {
          throw new Error(`Failed to capture screenshot for page ${pageNumber}`);
        }
        
        console.log('Screenshot captured successfully, size:', screenshot.length, 'bytes');
        screenshots.push(screenshot);
        
        // Try to go to next page using arrow key
        try {
          console.log('Pressing ArrowRight key for next page...');
          await page.keyboard.press('ArrowRight');
          console.log('Successfully pressed ArrowRight key');
          
          // Wait for page transition
          await page.waitForTimeout(2000);
          
          // Check if we're still on the same page by comparing screenshots
          const newScreenshot = await page.screenshot({
            fullPage: true,
            type: 'png',
            encoding: 'binary'
          });
          
          // If screenshots are identical, we're on the same page
          if (Buffer.compare(screenshot, newScreenshot) === 0) {
            console.log('Screenshots match, no page change detected');
            hasNextPage = false;
          } else {
            console.log('New page detected');
            pageNumber++;
          }
        } catch (error) {
          console.log('Error navigating to next page:', error);
          hasNextPage = false;
        }
      }
      
      console.log(`Captured ${screenshots.length} pages successfully`);
      return screenshots;
    } catch (error) {
      console.log('Error submitting form:', error);
      throw error;
    }
    
    // Wait for document content
    console.log('Waiting for document content...');
    const contentSelectors = [
      'iframe',
      'div[class*="viewer"]',
      'div[class*="document"]',
      'div[class*="content"]',
      'div[class*="page"]',
      'div[class*="slide"]',
      'div[class*="preview"]',
      'div[class*="embed"]'
    ];
    
    let contentFound = false;
    for (const selector of contentSelectors) {
      try {
        console.log('Checking for content with selector:', selector);
        const element = await page.waitForSelector(selector, { timeout: 30000 });
        console.log('Found content with selector:', selector);
        
        if (selector === 'iframe') {
          console.log('Switching to iframe...');
          const frameHandle = await element.contentFrame();
          if (frameHandle) {
            console.log('Successfully switched to iframe');
            // Wait for iframe content to load
            await frameHandle.waitForSelector('body', { timeout: 30000 });
            // Check for document content within iframe
            const iframeContentSelectors = [
              'div[class*="viewer"]',
              'div[class*="document"]',
              'div[class*="content"]',
              'div[class*="page"]',
              'div[class*="slide"]'
            ];
            
            for (const iframeSelector of iframeContentSelectors) {
              try {
                await frameHandle.waitForSelector(iframeSelector, { timeout: 10000 });
                console.log('Found document content in iframe with selector:', iframeSelector);
                contentFound = true;
                break;
              } catch (error) {
                console.log('Iframe content selector not found:', iframeSelector);
              }
            }
          }
        } else {
          // For non-iframe content, verify it's actually visible
          const isVisible = await page.evaluate(el => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && 
                   style.visibility !== 'hidden' && 
                   rect.width > 0 && 
                   rect.height > 0;
          }, element);
          
          if (isVisible) {
            console.log('Content is visible and has valid dimensions');
            contentFound = true;
          } else {
            console.log('Content found but not visible or has zero dimensions');
          }
        }
        
        if (contentFound) break;
      } catch (error) {
        console.log('Selector not found or error:', selector, error);
      }
    }
    
    if (!contentFound) {
      throw new Error('Could not find document content after checking all selectors');
    }
    
    // Capture screenshots of each page
    console.log('Capturing document pages...');
    const screenshots = [];
    
    // Document has multiple pages
    let pageNumber = 1;
    let hasNextPage = true;
    
    while (hasNextPage) {
      console.log(`Capturing page ${pageNumber}...`);
      
      // Click center of page to ensure focus
      const viewport = await page.viewport();
      const centerX = viewport.width / 2;
      const centerY = viewport.height / 2;
      await page.mouse.click(centerX, centerY);
      console.log('Clicked center of page for focus');
      
      // Take screenshot of current page
      const screenshot = await page.screenshot({
        fullPage: true,
        type: 'png',
        encoding: 'binary'
      });
      
      // Verify screenshot is valid
      if (!screenshot || !Buffer.isBuffer(screenshot) || screenshot.length === 0) {
        throw new Error(`Failed to capture screenshot for page ${pageNumber}`);
      }
      
      console.log('Screenshot captured successfully, size:', screenshot.length, 'bytes');
      screenshots.push(screenshot);
      
      // Try to go to next page using arrow key
      try {
        console.log('Pressing ArrowRight key for next page...');
        await page.keyboard.press('ArrowRight');
        console.log('Successfully pressed ArrowRight key');
        
        // Wait for page transition
        await page.waitForTimeout(2000);
        
        // Check if we're still on the same page by comparing screenshots
        const newScreenshot = await page.screenshot({
          fullPage: true,
          type: 'png',
          encoding: 'binary'
        });
        
        // If screenshots are identical, we're on the same page
        if (Buffer.compare(screenshot, newScreenshot) === 0) {
          console.log('Screenshots match, no page change detected');
          hasNextPage = false;
        } else {
          console.log('New page detected');
          pageNumber++;
        }
      } catch (error) {
        console.log('Error navigating to next page:', error);
        hasNextPage = false;
      }
    }
    
    console.log(`Captured ${screenshots.length} pages successfully`);
    return screenshots;
  } catch (error) {
    console.error('Error capturing document:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Function to convert screenshots to PDF
async function createPDFFromScreenshots(screenshots) {
  console.log('Creating PDF from screenshots...');
  const pdfDoc = await PDFDocument.create();
  
  for (let i = 0; i < screenshots.length; i++) {
    console.log(`Processing screenshot ${i + 1} of ${screenshots.length}...`);
    
    // Validate screenshot buffer
    if (!screenshots[i] || !Buffer.isBuffer(screenshots[i]) || screenshots[i].length === 0) {
      throw new Error(`Invalid screenshot buffer for page ${i + 1}`);
    }
    console.log(`Screenshot ${i + 1} buffer size: ${screenshots[i].length} bytes`);
    
    try {
      // Load the PNG image
      const pngImage = await pdfDoc.embedPng(screenshots[i]);
      console.log(`Successfully loaded PNG image ${i + 1}, dimensions: ${pngImage.width}x${pngImage.height}`);
      
      // Add a new page with the same dimensions as the image
      const page = pdfDoc.addPage([pngImage.width, pngImage.height]);
      
      // Draw the image on the page
      page.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: pngImage.width,
        height: pngImage.height,
      });
      
      console.log(`Successfully added page ${i + 1} as PNG`);
    } catch (error) {
      console.error(`Error processing screenshot ${i + 1}:`, error);
      throw new Error(`Failed to process screenshot ${i + 1}: ${error.message}`);
    }
  }
  
  console.log('Saving PDF...');
  try {
    const pdfBytes = await pdfDoc.save();
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
        
        // Extract DocSend URL
        const docsendUrl = messageText.match(/https:\/\/docsend\.com\/view\/[a-zA-Z0-9]+/)?.[0];
        if (docsendUrl) {
          console.log('Extracted DocSend URL:', docsendUrl);
          
          // Extract document ID from URL
          const docId = docsendUrl.split('/').pop();
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
          convertDocSendToPDF(docsendUrl)
            .then(async (screenshots) => {
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
              await app.client.chat.postMessage({
                channel: event.channel,
                text: `Sorry, I couldn't convert the DocSend document. Error: ${error.message}`,
                thread_ts: event.thread_ts || event.ts
              });
            });
        }
      }
    }
  }
});

// Start the Express server
const port = process.env.PORT || 10000;
expressApp.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Start the Slack app
app.start().then(() => {
  console.log('Slack app is running!');
}).catch((error) => {
  console.error('Error starting Slack app:', error);
}); 