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
      '--disable-features=IsolateOrigins,site-per-process'
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
      'Upgrade-Insecure-Requests': '1'
    });
    
    // Navigate to the DocSend URL
    console.log('Navigating to URL...');
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
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
    
    let emailForm = null;
    for (const selector of emailSelectors) {
      emailForm = await page.$(selector);
      if (emailForm) {
        console.log('Found email form with selector:', selector);
        break;
      }
    }
    
    if (emailForm) {
      console.log('Found email authentication form');
      
      // Get email from environment variable
      const docsendEmail = process.env.DOCSEND_EMAIL;
      if (!docsendEmail) {
        throw new Error('DOCSEND_EMAIL environment variable is not set');
      }
      
      // Enter email and submit
      console.log('Entering email and submitting form...');
      await page.type(emailSelectors[0], docsendEmail);
      
      // Try different submit button selectors
      const submitSelectors = [
        'button[type="submit"]',
        'form button',
        'input[type="submit"]',
        'button'
      ];
      
      let submitSuccess = false;
      for (const selector of submitSelectors) {
        try {
          console.log('Trying submit button selector:', selector);
          const submitButton = await page.$(selector);
          if (submitButton) {
            console.log('Found submit button with selector:', selector);
            await submitButton.click();
            submitSuccess = true;
            break;
          }
        } catch (error) {
          console.log('Error with selector:', selector, error);
        }
      }
      
      if (!submitSuccess) {
        // Try Enter key press
        try {
          console.log('Trying Enter key press...');
          await page.keyboard.press('Enter');
          submitSuccess = true;
        } catch (error) {
          console.log('Enter key press failed');
        }
      }
      
      if (!submitSuccess) {
        throw new Error('Failed to submit the email form');
      }
      
      // Wait for document to load after submission
      console.log('Waiting for document to load after form submission...');
      await page.waitForTimeout(10000);
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
    
    // Check for error messages
    const errorMessage = await page.$('.error-message');
    if (errorMessage) {
      const errorText = await page.evaluate(el => el.textContent, errorMessage);
      throw new Error(`Authentication error: ${errorText}`);
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
          type: 'png'
        });
        screenshots.push(screenshot);
        
        // Try to go to next page
        try {
          await nextButton.click();
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
        type: 'png'
      });
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
  
  // Create a new PDF document
  const pdfDoc = await PDFDocument.create();
  
  // Add each screenshot as a page
  for (const screenshot of screenshots) {
    // Convert PNG to JPEG for better PDF compatibility
    const jpegImage = await pdfDoc.embedJpg(screenshot);
    
    // Add a new page with the same dimensions as the image
    const page = pdfDoc.addPage([jpegImage.width, jpegImage.height]);
    
    // Draw the image on the page
    page.drawImage(jpegImage, {
      x: 0,
      y: 0,
      width: jpegImage.width,
      height: jpegImage.height,
    });
  }
  
  // Save the PDF
  const pdfBytes = await pdfDoc.save();
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