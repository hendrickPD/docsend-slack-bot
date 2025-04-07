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
    
    // Check for email form
    console.log('Checking for email form...');
    const emailForm = await page.waitForSelector('input[type="email"]', { timeout: 30000 });
    if (!emailForm) {
      throw new Error('Email form not found');
    }
    console.log('Email form found');
    
    // Wait for iframes to load
    console.log('Waiting for iframes to load...');
    await page.waitForFunction(() => {
      const iframes = document.querySelectorAll('iframe');
      return iframes.length > 0 && Array.from(iframes).every(iframe => iframe.contentDocument);
    }, { timeout: 30000 });
    console.log('Iframes loaded');
    
    // Find the correct frame that contains the email input
    console.log('Finding correct frame...');
    const frames = await page.frames();
    console.log('Found', frames.length, 'frames');
    
    let targetFrame = null;
    for (const frame of frames) {
      console.log('Checking frame:', frame.url());
      try {
        const emailInput = await frame.waitForSelector('input[type="email"]', { timeout: 5000 });
        if (emailInput) {
          console.log('Found email form in frame with selector: input[type="email"]');
          targetFrame = frame;
          break;
        }
      } catch (error) {
        // Frame doesn't have email input, continue to next frame
        continue;
      }
    }
    
    if (!targetFrame) {
      throw new Error('Could not find frame with email input');
    }
    console.log('Found target frame');
    
    // Get email from environment variable
    const docsendEmail = process.env.DOCSEND_EMAIL;
    if (!docsendEmail) {
      throw new Error('DOCSEND_EMAIL environment variable is not set');
    }
    
    // Check if this is a document that requires a password
    const requiresPassword = url.includes('pmfv4ph82dsfjeg6');
    const docsendPassword = requiresPassword ? 'landofthefr33' : null;
    
    // Enter email and submit form
    console.log('Entering email and submitting form...');
    await targetFrame.type('input[type="email"]', docsendEmail);
    console.log('Entered email in form');
    
    if (requiresPassword) {
      console.log('Password required for this document. Waiting for password input...');
      try {
        // Wait for the password input
        await targetFrame.waitForSelector('input[type="password"]', { timeout: 10000 });
        console.log('Found password input field');
        
        // Enter the password
        await targetFrame.type('input[type="password"]', docsendPassword);
        console.log('Entered password in form');
      } catch (error) {
        console.log('Password input not found or an error occurred:', error);
        throw new Error('Failed to enter password: ' + error.message);
      }
    }
    
    // Try to find and click the continue button
    console.log('Looking for continue button...');
    const continueButton = await targetFrame.$('button[type="submit"], input[type="submit"]');
    if (continueButton) {
      console.log('Found continue button, attempting to click...');
      try {
        await continueButton.click();
        console.log('Clicked continue button directly');
      } catch (clickError) {
        console.log('Direct click failed, trying alternative methods...');
        try {
          await targetFrame.evaluate(button => {
            button.dispatchEvent(new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              view: window
            }));
          }, continueButton);
          console.log('Dispatched click event');
        } catch (dispatchError) {
          console.log('Dispatch failed, trying keyboard events...');
          await targetFrame.focus('input[type="email"]');
          await targetFrame.keyboard.press('Enter');
          console.log('Pressed Enter key');
        }
      }
    } else {
      console.log('No continue button found, trying keyboard events...');
      await targetFrame.focus('input[type="email"]');
      await targetFrame.keyboard.press('Enter');
      console.log('Pressed Enter key');
    }
    
    // Wait for form submission
    console.log('Waiting for form submission...');
    try {
      await targetFrame.waitForFunction(() => {
        return !document.querySelector('input[type="email"]') && 
               !document.querySelector('input[type="password"]');
      }, { timeout: 30000 });
      console.log('Form submission successful');
    } catch (error) {
      console.log('Form might still be present, checking document state...');
      const formStillPresent = await targetFrame.evaluate(() => {
        return !!document.querySelector('input[type="email"]') || 
               !!document.querySelector('input[type="password"]');
      });
      
      if (formStillPresent) {
        throw new Error('Form submission failed - form is still present');
      }
      console.log('Form appears to be gone, continuing...');
    }
    
    // Wait for any cookie-related changes to take effect
    await page.waitForTimeout(2000);
    
    // Wait for the document to load
    await page.waitForSelector('.preso-view.page-view', { timeout: 10000 });

    // Hide header and navigation elements
    await page.evaluate(() => {
      // Hide header elements
      const headerSelectors = [
        'header',
        '.header',
        '.top-bar',
        '.header-bar-container',
        '.presentation-toolbar',
        '.toolbar-logo',
        '.presentation-toolbar_buttons',
        '.toolbar-page-indicator',
        '.toolbar-button',
        '.toolbar-rule',
        '.positioned-context',
        '.toolbar-popover',
        '.left.carousel-control',
        '.right.carousel-control',
        '#prevPageButton',
        '#nextPageButton',
        '#prevPageIcon',
        '#nextPageIcon'
      ];
      
      // Hide bottom navigation elements
      const bottomSelectors = [
        '.navbar-fixed-bottom',
        '.presentation-fixed-footer',
        '.presentation-privacy-policy',
        '.bottom-bar',
        '.footer',
        '.navigation',
        '.page-controls',
        '.controls'
      ];

      headerSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el) el.style.display = 'none';
        });
      });

      bottomSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el) el.style.display = 'none';
        });
      });
    });

    // Click center of page to ensure focus
    const viewport = await page.viewport();
    const centerX = viewport.width / 2;
    const centerY = viewport.height / 2;
    await page.mouse.click(centerX, centerY);
    console.log('Clicked center of page for focus');

    // Hide header and navigation elements
    await page.evaluate(() => {
      // Hide header elements
      const headerSelectors = [
        'header',
        '.header',
        '.top-bar',
        '.header-bar-container',
        '.presentation-toolbar',
        '.toolbar-logo',
        '.presentation-toolbar_buttons',
        '.toolbar-page-indicator',
        '.toolbar-button',
        '.toolbar-rule',
        '.positioned-context',
        '.toolbar-popover',
        '.left.carousel-control',
        '.right.carousel-control',
        '#prevPageButton',
        '#nextPageButton',
        '#prevPageIcon',
        '#nextPageIcon'
      ];
      
      // Hide bottom navigation elements
      const bottomSelectors = [
        '.navbar-fixed-bottom',
        '.presentation-fixed-footer',
        '.presentation-privacy-policy',
        '.bottom-bar',
        '.footer',
        '.navigation',
        '.page-controls',
        '.controls'
      ];

      headerSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el) el.style.display = 'none';
        });
      });

      bottomSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el) el.style.display = 'none';
        });
      });
    });

    // Take screenshot of current page
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'jpeg',
      quality: 80,
      encoding: 'binary'
    });

    // Get all image elements
    const imageElements = await page.evaluate(() => {
      const elements = document.querySelectorAll('img');
      return Array.from(elements).map(el => el.src);
    });
    
    // Capture screenshots of each page
    console.log('Capturing document pages...');
    const screenshots = [];
    
    // Document has multiple pages
    let pageNumber = 1;
    let hasNextPage = true;
    let lastPageNumber = null;
    
    while (hasNextPage) {
      console.log(`Capturing page ${pageNumber}...`);
      
      // Get current page number from the page number element
      const currentPageNumber = await page.evaluate(() => {
        const pageNumberElement = document.querySelector('span[aria-label="page number"]');
        if (pageNumberElement) {
          return parseInt(pageNumberElement.textContent, 10);
        }
        return null;
      });
      
      if (currentPageNumber) {
        console.log(`Current page number: ${currentPageNumber}`);
        
        // If we've seen this page number before, we've reached the end
        if (lastPageNumber === currentPageNumber) {
          console.log('Reached the end of the document (same page number detected)');
          hasNextPage = false;
          break;
        }
        
        lastPageNumber = currentPageNumber;
      }
      
      // Click center of page to ensure focus
      const viewport = await page.viewport();
      const centerX = viewport.width / 2;
      const centerY = viewport.height / 2;
      await page.mouse.click(centerX, centerY);
      console.log('Clicked center of page for focus');
      
      // Hide header and navigation elements
      await page.evaluate(() => {
        // Hide header elements
        const headerSelectors = [
          'header',
          '.header',
          '.top-bar',
          '.header-bar-container',
          '.presentation-toolbar',
          '.toolbar-logo',
          '.presentation-toolbar_buttons',
          '.toolbar-page-indicator',
          '.toolbar-button',
          '.toolbar-rule',
          '.positioned-context',
          '.toolbar-popover',
          '.left.carousel-control',
          '.right.carousel-control',
          '#prevPageButton',
          '#nextPageButton',
          '#prevPageIcon',
          '#nextPageIcon'
        ];
        
        // Hide bottom navigation elements
        const bottomSelectors = [
          '.navbar-fixed-bottom',
          '.presentation-fixed-footer',
          '.presentation-privacy-policy',
          '.bottom-bar',
          '.footer',
          '.navigation',
          '.page-controls',
          '.controls'
        ];

        headerSelectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            if (el) el.style.display = 'none';
          });
        });

        bottomSelectors.forEach(selector => {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            if (el) el.style.display = 'none';
          });
        });
      });

      // Take screenshot of current page
      const screenshot = await page.screenshot({
        fullPage: true,
        type: 'jpeg',
        quality: 80,
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
        
        // Get new page number after navigation
        const newPageNumber = await page.evaluate(() => {
          const pageNumberElement = document.querySelector('span[aria-label="page number"]');
          if (pageNumberElement) {
            return parseInt(pageNumberElement.textContent, 10);
          }
          return null;
        });
        
        if (newPageNumber) {
          console.log(`New page number: ${newPageNumber}`);
          if (newPageNumber === currentPageNumber) {
            console.log('Page number unchanged, reached end of document');
            hasNextPage = false;
          } else {
            pageNumber++;
          }
        } else {
          // If we can't get the page number, fall back to screenshot comparison
          const newScreenshot = await page.screenshot({
            fullPage: true,
            type: 'jpeg',
            quality: 80,
            encoding: 'binary'
          });
          
          if (Buffer.compare(screenshot, newScreenshot) === 0) {
            console.log('Screenshots match, no page change detected');
            hasNextPage = false;
          } else {
            console.log('New page detected');
            pageNumber++;
          }
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
(async () => {
  try {
    // Run health check
    await checkHealth();
    
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