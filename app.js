require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { convertDocSendToPDF, createPDFFromScreenshots } = require('./docsend');
const { convertPitchToPDF } = require('./pitch');
const { closeSharedBrowser } = require('./browser');

// Full request/event/signature logging is only useful when debugging; the
// always-on version buried real log lines under health checks firing every 5s.
const DEBUG = process.env.DEBUG_LOGS === '1';

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

// Add request logging middleware (health checks and header/body dumps are
// DEBUG-only noise)
expressApp.use((req, res, next) => {
  const isHealthCheck = req.headers['render-health-check'] === '1';
  if (!isHealthCheck || DEBUG) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  if (DEBUG) {
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
  }
  next();
});

// Track processed messages to prevent duplicates. Capped so the set doesn't
// grow forever — Set preserves insertion order, so the oldest entry goes first.
const processedMessages = new Set();
const MAX_PROCESSED_MESSAGES = 500;

function markMessageProcessed(messageKey) {
  processedMessages.add(messageKey);
  if (processedMessages.size > MAX_PROCESSED_MESSAGES) {
    processedMessages.delete(processedMessages.values().next().value);
  }
}

// Serialize conversions: each one spawns a headless Chrome, and running several
// at once exceeds the instance's memory and gets the process OOM-killed (exit 137)
const conversionQueue = [];
let conversionActive = false;

function enqueueConversion(job) {
  conversionQueue.push(job);
  if (!conversionActive) {
    processNextConversion();
  }
}

async function processNextConversion() {
  const job = conversionQueue.shift();
  if (!job) {
    conversionActive = false;
    // Free the shared Chromium's memory while the bot sits idle.
    closeSharedBrowser().catch(console.error);
    return;
  }
  conversionActive = true;
  try {
    await job();
  } catch (error) {
    console.error('Conversion job failed:', error);
  }
  processNextConversion();
}

// DocSend links with the owner's "verify email" option on: the conversion is
// parked here until someone pastes the verification link DocSend emailed into
// the same thread. Keyed by channel + thread so the reply can be matched.
const pendingVerifications = new Map();
const PENDING_VERIFICATION_TTL_MS = 30 * 60 * 1000;

function pendingKey(channel, threadTs) {
  return `${channel}:${threadTs}`;
}

function getPendingVerification(channel, threadTs) {
  const key = pendingKey(channel, threadTs);
  const pending = pendingVerifications.get(key);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_VERIFICATION_TTL_MS) {
    pendingVerifications.delete(key);
    return null;
  }
  return pending;
}

// The emailed link is usually an email-tracking redirect (e.g. track.pstmrk.it)
// whose path carries the docsend.com target URL-encoded, so accept any URL
// that mentions docsend.com once decoded. Slack wraps links as <url|label>
// and HTML-escapes "&"; the one-time token lives in the URL, so keep it intact.
function extractDocSendVerificationUrl(text) {
  const urls = text.match(/https?:\/\/[^\s<>|]+/g) || [];
  for (const raw of urls) {
    const cleaned = raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[.,;:)]+$/, '');
    let decoded = cleaned;
    try { decoded = decodeURIComponent(decodeURIComponent(cleaned)); } catch (_) {}
    if (/docsend\.com/i.test(decoded)) return cleaned;
  }
  return null;
}

// Convert one document and post the result (or the failure) in its thread.
function runConversion({ channel, threadTs, provider, convert, docUrl, docId, messageText, convertOpts = {} }) {
  enqueueConversion(() => convert(docUrl, messageText, convertOpts)
    .then(async (screenshots) => {
      if (!screenshots || !Array.isArray(screenshots)) {
        throw new Error(`No screenshots returned from ${provider} conversion`);
      }
      console.log(`Captured ${screenshots.length} pages, creating PDF...`);

      const pdfBuffer = await createPDFFromScreenshots(screenshots);
      if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
        throw new Error('Invalid PDF buffer generated');
      }
      console.log('PDF buffer size:', pdfBuffer.length, 'bytes');

      try {
        const result = await app.client.files.uploadV2({
          channel_id: channel,
          file: pdfBuffer,
          filename: `${docId}.pdf`,
          title: `${provider} Document ${docId}`,
          thread_ts: threadTs,
          initial_comment: `Here is your ${provider} document converted to PDF.`
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
      if (error.code === 'EMAIL_VERIFICATION_REQUIRED') {
        pendingVerifications.set(pendingKey(channel, threadTs), {
          provider, convert, docUrl, docId, messageText,
          cookies: error.cookies,
          createdAt: Date.now()
        });
        console.log(`Parked conversion of ${docUrl} pending email verification`);
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: [
            `This link requires email verification, so I can't open it on my own.`,
            `DocSend just emailed a verification link to *${error.email}*.`,
            `Open that email, copy the link, and paste it here in this thread *without clicking it first* (it only works once, and I need to be the one who opens it). You have 30 minutes; after that, post the DocSend link again for a fresh one.`
          ].join('\n')
        }).catch(console.error);
        return;
      }

      console.error(`Error processing ${provider} document:`, error);
      const text = convertOpts.verifyUrl
        ? `Sorry, that verification link didn't unlock the ${provider} document. It has probably expired or was already clicked, since each link works once. Post the DocSend link again, then paste the new link from the newest email without opening it.`
        : `Sorry, I couldn't convert the ${provider} document. It might require special access or have security restrictions.`;
      await app.client.chat.postMessage({ channel, thread_ts: threadTs, text }).catch(console.error);
    }));
}

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

  if (DEBUG) {
    console.log('Verifying signature:', {
      received: signature,
      computed: mySignature,
      basestring: sigBasestring
    });
  }

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(mySignature)
  );
};

// Handle Slack events directly
expressApp.post('/slack/events', (req, res) => {
  if (DEBUG) {
    console.log('Received Slack event:', JSON.stringify(req.body));
  } else {
    const ev = req.body.event || {};
    console.log(`Received Slack event: ${req.body.type}/${ev.type || ''}${ev.subtype ? `/${ev.subtype}` : ''} channel=${ev.channel || ''} ts=${ev.ts || ''}`);
  }

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

      // A reply in a thread where a conversion is parked waiting for the
      // DocSend verification link: finish that conversion with the link.
      const replyThreadTs = event.thread_ts || event.message?.thread_ts;
      if (replyThreadTs && !event.bot_id && event.subtype !== 'message_deleted'
          && messageText.includes('docsend.com')) {
        const pending = getPendingVerification(event.channel, replyThreadTs);
        const verifyUrl = pending ? extractDocSendVerificationUrl(messageText) : null;
        if (pending && verifyUrl) {
          const messageKey = `${messageId}_verify_${verifyUrl}`;
          if (processedMessages.has(messageKey)) {
            console.log('Verification message already processed, skipping');
            return;
          }
          markMessageProcessed(messageKey);
          pendingVerifications.delete(pendingKey(event.channel, replyThreadTs));
          console.log('Received verification link for parked conversion of', pending.docUrl);

          app.client.chat.postMessage({
            channel: event.channel,
            thread_ts: replyThreadTs,
            text: 'Got the verification link, finishing the conversion...'
          }).catch(console.error);

          runConversion({
            channel: event.channel,
            threadTs: replyThreadTs,
            provider: pending.provider,
            convert: pending.convert,
            docUrl: pending.docUrl,
            docId: pending.docId,
            messageText: pending.messageText,
            convertOpts: { verifyUrl, cookies: pending.cookies }
          });
          return;
        }
      }

      // Check if the message contains a DocSend or Pitch link
      if (messageText && (messageText.includes('docsend.com') || messageText.includes('pitch.com'))) {
        console.log('Found document link:', messageText);

        // Extract DocSend URL (handle both /view/ and /v/ formats, with or without angle brackets, and custom subdomains)
        const docsendUrl = messageText.match(/<?(https:\/\/(?:[a-zA-Z0-9-]+\.)?docsend\.com\/(?:view\/|v\/)[a-zA-Z0-9\/\-_]+)>?/)?.[1];
        // Extract Pitch URL (share links: pitch.com/v/<slug>, older pitch.com/public/<id>)
        const pitchUrl = messageText.match(/<?(https:\/\/pitch\.com\/(?:v|public)\/[a-zA-Z0-9\/\-_]+)>?/)?.[1];
        const docUrl = docsendUrl || pitchUrl;
        if (docUrl) {
          const provider = docsendUrl ? 'DocSend' : 'Pitch';
          const convert = docsendUrl ? convertDocSendToPDF : convertPitchToPDF;
          console.log(`Extracted ${provider} URL:`, docUrl);

          // Extract document ID from URL (last path segment; for DocSend the
          // segment after /view/ or /v/, for Pitch the deck slug)
          const docId = docsendUrl
            ? (docsendUrl.includes('/view/')
                ? docsendUrl.split('/view/')[1].split('/')[0]
                : docsendUrl.split('/v/')[1].split('/')[0])
            : pitchUrl.split('/').filter(Boolean).pop();
          console.log('Extracted document ID:', docId);

          // Create a unique key for this message
          const messageKey = `${messageId}_${docUrl}`;

          // Check if we've already processed this message
          if (processedMessages.has(messageKey)) {
            console.log('Message already processed, skipping:', messageKey);
            return;
          }

          // Mark this message as processed
          markMessageProcessed(messageKey);

          const threadTs = event.thread_ts || event.ts;

          // Send initial response
          const queueAhead = conversionQueue.length + (conversionActive ? 1 : 0);
          app.client.chat.postMessage({
            channel: event.channel,
            text: queueAhead > 0
              ? `Queued ${provider} conversion (${queueAhead} ahead of it)...`
              : `Converting ${provider} document to PDF...`,
            thread_ts: threadTs
          }).catch(console.error);

          // Convert to screenshots and create PDF, one document at a time
          runConversion({ channel: event.channel, threadTs, provider, convert, docUrl, docId, messageText });
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
