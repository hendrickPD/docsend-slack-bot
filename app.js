require('dotenv').config();
const { App } = require('@slack/bolt');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Function to convert DocSend link to PDF
async function convertDocSendToPDF(url) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Navigate to DocSend login page
    await page.goto('https://docsend.com/login');

    // Login to DocSend
    await page.type('input[type="email"]', process.env.DOCSEND_EMAIL);
    await page.type('input[type="password"]', process.env.DOCSEND_PASSWORD);
    await page.click('button[type="submit"]');

    // Wait for login to complete
    await page.waitForNavigation();

    // Navigate to the document
    await page.goto(url, { waitUntil: 'networkidle0' });

    // Wait for the document to load
    await page.waitForSelector('.document-view');

    // Generate PDF
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
    });

    return pdf;
  } finally {
    await browser.close();
  }
}

// Listen for messages containing DocSend links
app.message(/docsend\.com\/view\//, async ({ message, say }) => {
  try {
    await say({
      text: "I'll convert that DocSend link to a PDF for you! Please wait...",
      thread_ts: message.ts
    });

    // Extract DocSend URL from message
    const urlMatch = message.text.match(/(https:\/\/docsend\.com\/view\/[^\s]+)/);
    if (!urlMatch) {
      throw new Error('No valid DocSend URL found in message');
    }

    const docSendUrl = urlMatch[1];
    const pdf = await convertDocSendToPDF(docSendUrl);

    // Save PDF temporarily
    const tempFilePath = path.join(__dirname, 'temp.pdf');
    fs.writeFileSync(tempFilePath, pdf);

    // Upload PDF to Slack
    try {
      await app.client.files.upload({
        channels: message.channel,
        thread_ts: message.ts,
        initial_comment: "Here's your PDF version of the DocSend document:",
        file: fs.createReadStream(tempFilePath),
        filename: 'document.pdf'
      });
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

// Start the app
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Bolt app is running on port ${port}!`);
})(); 