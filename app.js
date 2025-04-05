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
      
      // Try to find and click submit button
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button[class*="submit"]',
        'button[class*="continue"]',
        'input[class*="submit"]',
        'input[class*="continue"]',
        'button[class*="button"]',
        'input[class*="button"]',
        'button[class*="btn"]',
        'input[class*="btn"]',
        'button[class*="primary"]',
        'input[class*="primary"]',
        'button[class*="action"]',
        'input[class*="action"]'
      ];
      
      // Monitor network requests
      let formSubmitted = false;
      const responsePromise = new Promise((resolve, reject) => {
        page.on('response', async response => {
          const url = response.url();
          console.log('Network response:', url);
          
          // Look for form submission response
          if (url.includes('docsend.com') && 
              (url.includes('/auth') || url.includes('/email') || url.includes('/verify'))) {
            console.log('Found form submission response:', {
              url: url,
              status: response.status(),
              ok: response.ok()
            });
            
            if (response.ok()) {
              formSubmitted = true;
              resolve(response);
            }
          }
        });
        
        // Set a timeout
        setTimeout(() => {
          if (!formSubmitted) {
            reject(new Error('Form submission response timeout'));
          }
        }, 30000);
      });
      
      // Click the submit button and wait for response
      let submitted = false;
      for (const selector of submitSelectors) {
        try {
          const submitButton = await targetFrame.$(selector);
          if (submitButton) {
            // Get button text and state for logging
            const buttonState = await targetFrame.evaluate(el => {
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return {
                text: el.textContent || el.value || '',
                visible: style.display !== 'none' && style.visibility !== 'hidden',
                clickable: style.pointerEvents !== 'none',
                disabled: el.disabled,
                position: {
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  height: rect.height
                },
                computedStyle: {
                  display: style.display,
                  visibility: style.visibility,
                  opacity: style.opacity,
                  pointerEvents: style.pointerEvents,
                  position: style.position,
                  zIndex: style.zIndex
                }
              };
            }, submitButton);
            
            console.log('Found submit button with selector:', selector, 'state:', buttonState);
            
            // Wait for button to have non-zero dimensions
            if (buttonState.position.width === 0 || buttonState.position.height === 0) {
              console.log('Button has zero dimensions, waiting for proper rendering...');
              await targetFrame.waitForFunction(
                el => {
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                },
                { timeout: 10000 },
                submitButton
              );
              console.log('Button now has non-zero dimensions');
            }
            
            // Scroll button into view
            console.log('Scrolling button into view...');
            await targetFrame.evaluate(el => {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, submitButton);
            await page.waitForTimeout(1000); // Wait for scroll animation
            
            // Wait for button to be enabled
            if (buttonState.disabled) {
              console.log('Button is disabled, waiting for it to become enabled...');
              await targetFrame.waitForFunction(
                el => !el.disabled,
                { timeout: 10000 },
                submitButton
              );
              console.log('Button is now enabled');
            }
            
            // Try multiple click methods
            try {
              // Method 1: Direct click
              console.log('Attempting direct click...');
              await submitButton.click();
            } catch (clickError) {
              console.log('Direct click failed, trying JavaScript click...');
              
              // Method 2: JavaScript click
              await targetFrame.evaluate(el => {
                el.dispatchEvent(new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  view: window
                }));
              }, submitButton);
            }
            
            // Wait for response
            console.log('Waiting for form submission response...');
            await responsePromise;
            
            console.log('Form submitted successfully');
            submitted = true;
            break;
          }
        } catch (error) {
          console.log('Failed to interact with button using selector:', selector, error);
        }
      }
      
      if (!submitted) {
        // Try pressing Enter as fallback
        console.log('Trying Enter key as fallback...');
        
        // Focus the email input first
        const emailInput = await targetFrame.$('input[type="email"]');
        if (emailInput) {
          console.log('Focusing email input...');
          await emailInput.focus();
          await page.waitForTimeout(500);
          
          // Press Enter and wait for response
          await Promise.all([
            emailInput.press('Enter'),
            responsePromise
          ]);
          console.log('Pressed Enter and received response');
        } else {
          throw new Error('Could not find email input for Enter key fallback');
        }
      }
      
      // Wait for success indicators
      console.log('Waiting for success indicators...');
      
      // Define success indicators
      const successIndicators = [
        '.submission-success',
        '.success-message',
        '.alert-success',
        '.message-success',
        'div[class*="success"]',
        'div[class*="Success"]',
        'div[class*="submitted"]',
        'div[class*="Submitted"]',
        'div[class*="complete"]',
        'div[class*="Complete"]',
        'div[class*="done"]',
        'div[class*="Done"]',
        'iframe[src*="docsend"]',
        'div[class*="viewer"]',
        'div[class*="document"]',
        'div[class*="content"]'
      ];
      
      // Wait for any success indicator
      let successFound = false;
      for (const indicator of successIndicators) {
        try {
          console.log('Checking for success indicator:', indicator);
          await targetFrame.waitForSelector(indicator, { timeout: 10000 });
          console.log('Found success indicator:', indicator);
          successFound = true;
          break;
        } catch (error) {
          console.log('Success indicator not found:', indicator);
        }
      }
      
      if (!successFound) {
        // Check if we're still on the email form
        const stillOnEmailForm = await targetFrame.$(emailSelectors[0]);
        if (stillOnEmailForm) {
          throw new Error('Form submission appears to have failed - still on email form');
        }
        
        // If not on email form, assume success and continue
        console.log('No success indicators found, but not on email form - assuming success');
      }
      
      // Wait a bit for any dynamic content to load
      await page.waitForTimeout(5000);
      
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
        await page.waitForSelector(selector, { timeout: 30000 });
        console.log('Found content with selector:', selector);
        contentFound = true;
        
        // If it's an iframe, switch to it
        if (selector === 'iframe') {
          console.log('Switching to iframe...');
          const frame = await page.$(selector);
          if (frame) {
            const frameHandle = await frame.contentFrame();
            if (frameHandle) {
              console.log('Successfully switched to iframe');
              await frameHandle.waitForSelector('body', { timeout: 30000 });
            }
          }
        }
        
        break;
      } catch (error) {
        console.log('Selector not found:', selector);
      }
    }
    
    if (!contentFound) {
      throw new Error('Could not find document content');
    }
    
    // Capture screenshots of each page
    console.log('Capturing document pages...');
    const screenshots = [];
    
    // Try to find page navigation elements
    const pageNavSelectors = [
      'button[aria-label*="next" i]',
      'button[aria-label*="Next" i]',
      'button[class*="next" i]',
      'button[class*="Next" i]',
      'div[class*="next" i]',
      'div[class*="Next" i]'
    ];
    
    let nextButton = null;
    for (const selector of pageNavSelectors) {
      nextButton = await page.$(selector);
      if (nextButton) {
        console.log('Found next button with selector:', selector);
        break;
      }
    }
    
    if (nextButton) {
      // Document has multiple pages
      let pageNumber = 1;
      let hasNextPage = true;
      
      while (hasNextPage) {
        console.log(`Capturing page ${pageNumber}...`);
        
        // Take screenshot of current page
        const screenshot = await page.screenshot({
          fullPage: true,
          type: 'png',
          encoding: 'binary'
        });
        
        // Verify screenshot is valid
        if (!screenshot || screenshot.length === 0) {
          throw new Error(`Failed to capture screenshot for page ${pageNumber}`);
        }
        
        screenshots.push(screenshot);
        
        // Try to go to next page
        try {
          await page.evaluate((selector) => {
            const button = document.querySelector(selector);
            if (button) {
              button.click();
              return true;
            }
            return false;
          }, pageNavSelectors[0]);
          
          await page.waitForTimeout(2000); // Wait for page transition
          
          // Check if we're still on the same page
          const newNextButton = await page.$(pageNavSelectors[0]);
          if (!newNextButton || newNextButton === nextButton) {
            hasNextPage = false;
          } else {
            nextButton = newNextButton;
            pageNumber++;
          }
        } catch (error) {
          console.log('Error navigating to next page:', error);
          hasNextPage = false;
        }
      }
    } else {
      // Single page document
      console.log('Capturing single page document...');
      const screenshot = await page.screenshot({
        fullPage: true,
        type: 'png',
        encoding: 'binary'
      });
      
      // Verify screenshot is valid
      if (!screenshot || screenshot.length === 0) {
        throw new Error('Failed to capture screenshot for single page document');
      }
      
      screenshots.push(screenshot);
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
    try {
      console.log(`Processing screenshot ${i + 1} of ${screenshots.length}...`);
      
      // First try to embed as PNG
      try {
        const pngImage = await pdfDoc.embedPng(screenshots[i]);
        const page = pdfDoc.addPage([pngImage.width, pngImage.height]);
        page.drawImage(pngImage, {
          x: 0,
          y: 0,
          width: pngImage.width,
          height: pngImage.height,
        });
        console.log(`Successfully added page ${i + 1} as PNG`);
        continue;
      } catch (pngError) {
        console.log(`Failed to embed as PNG, trying JPEG: ${pngError.message}`);
      }
      
      // If PNG fails, try JPEG
      try {
        const jpegImage = await pdfDoc.embedJpg(screenshots[i]);
        const page = pdfDoc.addPage([jpegImage.width, jpegImage.height]);
        page.drawImage(jpegImage, {
          x: 0,
          y: 0,
          width: jpegImage.width,
          height: jpegImage.height,
        });
        console.log(`Successfully added page ${i + 1} as JPEG`);
      } catch (jpegError) {
        console.error(`Failed to embed page ${i + 1} as JPEG: ${jpegError.message}`);
        throw new Error(`Failed to process screenshot ${i + 1}: ${jpegError.message}`);
      }
    } catch (error) {
      console.error(`Error processing screenshot ${i + 1}:`, error);
      throw error;
    }
  }
  
  console.log('Saving PDF...');
  const pdfBytes = await pdfDoc.save();
  console.log('PDF created successfully');
  return pdfBytes;
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
              
              // Upload PDF to Slack
              const result = await app.client.files.upload({
                channels: event.channel,
                file: pdfBuffer,
                filename: 'document.pdf',
                title: 'DocSend Document',
                thread_ts: event.thread_ts || event.ts
              });
              
              console.log('PDF uploaded successfully:', result);
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