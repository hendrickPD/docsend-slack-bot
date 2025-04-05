require('dotenv').config();
const { App } = require('@slack/bolt');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Initialize Express app
const expressApp = express();
const port = process.env.PORT || 10000;

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// Function to extract password from DocSend URL
function extractPasswordFromUrl(url) {
  const passwordMatch = url.match(/[?&]password=([^&]+)/);
  return passwordMatch ? decodeURIComponent(passwordMatch[1]) : null;
}

// Function to convert DocSend link to PDF
async function convertDocSendToPDF(url) {
  console.log('Starting PDF conversion for URL:', url);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const password = extractPasswordFromUrl(url);

    // Navigate to the document
    console.log('Navigating to URL...');
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Check if we're on the email page
    const isEmailPage = await page.evaluate(() => {
      return document.querySelector('input[type="email"]') !== null;
    });

    if (isEmailPage) {
      console.log('Email page detected');
      // Use default email from environment variables
      if (process.env.DOCSEND_EMAIL) {
        await page.type('input[type="email"]', process.env.DOCSEND_EMAIL);
        await page.click('button[type="submit"]');
        await page.waitForNavigation();
      } else {
        throw new Error('This DocSend link requires an email. Please set DOCSEND_EMAIL in the environment variables.');
      }
    }

    // Check if we're on the password page
    const isPasswordPage = await page.evaluate(() => {
      return document.querySelector('input[type="password"]') !== null;
    });

    if (isPasswordPage) {
      console.log('Password page detected');
      if (password) {
        // If password is in URL, use it
        await page.type('input[type="password"]', password);
        await page.click('button[type="submit"]');
        await page.waitForNavigation();
      } else {
        // If no password in URL, check if we have a default password
        if (process.env.DOCSEND_PASSWORD) {
          await page.type('input[type="password"]', process.env.DOCSEND_PASSWORD);
          await page.click('button[type="submit"]');
          await page.waitForNavigation();
        } else {
          throw new Error('This DocSend link requires a password. Please provide it in the URL or set a default password in the environment variables.');
        }
      }
    }

    // Wait for the document to load
    console.log('Waiting for document to load...');
    await page.waitForSelector('.document-view', { timeout: 10000 });

    // Generate PDF
    console.log('Generating PDF...');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    console.log('PDF generated successfully');
    return pdf;
  } catch (error) {
    console.error('PDF conversion error:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Listen for messages containing DocSend links
app.message(/([a-zA-Z0-9-]+\.)?docsend\.com\/view\//, async ({ message, say }) => {
  console.log('Received message:', message.text);
  try {
    await say({
      text: "I'll convert that DocSend link to a PDF for you! Please wait...",
      thread_ts: message.ts
    });

    // Extract DocSend URL from message
    const urlMatch = message.text.match(/(https?:\/\/(?:[a-zA-Z0-9-]+\.)?docsend\.com\/view\/[^\s]+)/);
    console.log('URL match:', urlMatch);
    
    if (!urlMatch) {
      throw new Error('No valid DocSend URL found in message');
    }

    const docSendUrl = urlMatch[1];
    console.log('Processing URL:', docSendUrl);
    const pdf = await convertDocSendToPDF(docSendUrl);

    // Save PDF temporarily
    const tempFilePath = path.join(__dirname, 'temp.pdf');
    fs.writeFileSync(tempFilePath, pdf);

    // Upload PDF to Slack
    try {
      console.log('Uploading PDF to Slack...');
      await app.client.files.upload({
        channels: message.channel,
        thread_ts: message.ts,
        initial_comment: "Here's your PDF version of the DocSend document:",
        file: fs.createReadStream(tempFilePath),
        filename: 'document.pdf'
      });
      console.log('PDF uploaded successfully');
    } finally {
      // Clean up temporary file
      fs.unlinkSync(tempFilePath);
    }
  } catch (error) {
    console.error('Error:', error);
    await say({
      text: `Sorry, I encountered an error: ${error.message}`,
      thread_ts: message.ts
    });
  }
});

// Health check endpoint
expressApp.get('/', (req, res) => {
  res.send('DocSend to PDF Slack Bot is running!');
});

// Start the Express server
const server = expressApp.listen(port, () => {
  console.log(`Express server is running on port ${port}`);
});

// Start the Slack app
(async () => {
  try {
    await app.start(port);
    console.log('⚡️ Bolt app is running!');
  } catch (error) {
    console.error('Error starting Slack app:', error);
    server.close();
    process.exit(1);
  }
})(); 