require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { convertDocSendToPDF, createPDFFromScreenshots } = require('./docsend');
const { downloadVideo, SLACK_MAX_BYTES } = require('./video');
const { convertPitchToPDF } = require('./pitch');
const { closeSharedBrowser } = require('./browser');
const { classifyReply } = require('./threadReplies');

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

// Conversions parked on something only a person can supply: the DocSend
// verification link, a passcode, or a different email address. Keyed by
// channel + thread so the next reply in that thread can be matched.
// kind: 'verify' (waiting for the emailed link) | 'passcode' | 'email'
const pendingPrompts = new Map();
const PENDING_PROMPT_TTL_MS = 30 * 60 * 1000;

function pendingKey(channel, threadTs) {
  return `${channel}:${threadTs}`;
}

function getPendingPrompt(channel, threadTs) {
  const key = pendingKey(channel, threadTs);
  const pending = pendingPrompts.get(key);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > PENDING_PROMPT_TTL_MS) {
    pendingPrompts.delete(key);
    return null;
  }
  return pending;
}

function parkConversion(kind, { channel, threadTs, provider, convert, docUrl, docId, messageText, cookies, email }) {
  pendingPrompts.set(pendingKey(channel, threadTs), {
    kind, provider, convert, docUrl, docId, messageText, cookies, email,
    createdAt: Date.now()
  });
  console.log(`Parked conversion of ${docUrl} pending ${kind}`);
}

// The email entered at DocSend's gate is the poster's own Slack profile
// email when the app may read it (bot scope users:read.email, plus
// users:read), so a verification link lands in their inbox rather than the
// shared DOCSEND_EMAIL one. Cached per user; a missing scope is logged once.
const userEmailCache = new Map();
let userEmailScopeWarned = false;

async function lookupPosterEmail(userId) {
  if (!userId) return null;
  if (userEmailCache.has(userId)) return userEmailCache.get(userId);
  let email = null;
  try {
    const result = await app.client.users.info({ user: userId });
    email = result.user?.profile?.email || null;
    if (!email) console.log(`No profile email for Slack user ${userId}`);
  } catch (error) {
    if (error.data?.error === 'missing_scope') {
      if (!userEmailScopeWarned) {
        userEmailScopeWarned = true;
        console.log('Cannot read poster emails: add the users:read and users:read.email bot scopes and reinstall the Slack app. Falling back to DOCSEND_EMAIL.');
      }
    } else {
      console.log(`users.info failed for ${userId}:`, error.data?.error || error.message);
    }
  }
  userEmailCache.set(userId, email);
  return email;
}

const EMAIL_OVERRIDE_HINT = (email) =>
  `I used *${email}*. If the document was shared with a different address, reply here with that email and I'll use it instead.`;

// Dataroom entries that are not documents still open in the viewer, but the
// PDF is only a snapshot: say so next to the file. (A video normally arrives
// as an MP4 instead; this note covers one whose stream could not be found.)
function dataroomTypeNote(type) {
  if (type === 'WEB_LINK') return ' — a web link, so this is a snapshot of that page';
  if (type === 'PRESENTATION_VIDEO') return ' — a video, so this is its cover frame only';
  return '';
}

// Slack rejects some characters in filenames; keep titles readable otherwise.
function safeFilename(title, fallback, ext) {
  const base = String(title || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${base || fallback}.${ext}`;
}

function pdfFilename(title, fallback) {
  return safeFilename(title, fallback, 'pdf');
}

function formatMb(bytes) {
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

async function uploadPdf({ channel, threadTs, pdfBuffer, filename, title, initialComment }) {
  try {
    const result = await app.client.files.uploadV2({
      channel_id: channel,
      file: pdfBuffer,
      filename,
      title,
      thread_ts: threadTs,
      initial_comment: initialComment
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
}

// Post a file that already sits on disk, streaming it: files.uploadV2 reads a
// stream fully into memory first, and an MP4 can be a large share of this
// instance's RAM. Same three steps Slack's SDK performs (external upload URL,
// POST of the bytes, completeUploadExternal into the thread).
async function uploadFileFromDisk({ channel, threadTs, filePath, filename, title, initialComment }) {
  const { size } = await fs.promises.stat(filePath);
  const { upload_url: uploadUrl, file_id: fileId } = await app.client.files.getUploadURLExternal({ filename, length: size });
  await new Promise((resolve, reject) => {
    const req = https.request(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 500) body += chunk.slice(0, 500); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Slack file upload returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('Slack file upload timed out')));
    req.on('error', reject);
    fs.createReadStream(filePath).on('error', (e) => req.destroy(e)).pipe(req);
  });
  const result = await app.client.files.completeUploadExternal({
    files: [{ id: fileId, title }],
    channel_id: channel,
    thread_ts: threadTs,
    initial_comment: initialComment
  });
  const file = result.files && result.files[0];
  console.log('File uploaded successfully:', { file_id: file?.id || fileId, filename, size });
  return file;
}

// Fetch a DocSend video as an MP4 (video.js: ffmpeg into a temp file) and
// post it in the thread. The temp file is deleted whatever happens.
async function postVideo({ channel, threadTs, title, playlistUrl, filename, initialComment }) {
  console.log(`Fetching video "${title}" from ${playlistUrl.split('?')[0]}`);
  const video = await downloadVideo(playlistUrl, { maxBytes: SLACK_MAX_BYTES });
  try {
    console.log(`Video ready: ${video.name} ${video.width}x${video.height}, ${formatMb(video.bytes)}; uploading to Slack...`);
    await uploadFileFromDisk({ channel, threadTs, filePath: video.path, filename, title, initialComment });
  } finally {
    await video.cleanup();
  }
}

// Convert one document (or every document of a dataroom) and post the result
// (or the failure) in its thread.
function runConversion({ channel, threadTs, provider, convert, docUrl, docId, messageText, convertOpts = {} }) {
  // Dataroom documents are posted one by one as they are captured, so the
  // pages of a 30-document room never sit in memory together.
  const onDocument = async (doc, index, total) => {
    const label = `${index + 1}/${total}: *${doc.title}*${doc.folder ? ` (${doc.folder})` : ''}`;
    if (doc.webLink) {
      await app.client.chat.postMessage({
        channel, thread_ts: threadTs,
        text: `${label} is a web link, not a document: ${doc.url}`
      }).catch(console.error);
      return;
    }
    if (doc.video) {
      // Fetch right away: the playlist URL is signed and expires.
      try {
        await postVideo({
          channel, threadTs,
          title: doc.title,
          playlistUrl: doc.playlistUrl,
          filename: safeFilename(doc.title, `${docId}-${index + 1}`, 'mp4'),
          initialComment: `${label} — video, posted as an MP4`
        });
      } catch (error) {
        console.error(`Video "${doc.title}" failed:`, error);
        await app.client.chat.postMessage({
          channel, thread_ts: threadTs,
          text: `${label} is a video I couldn't fetch as an MP4 (${error.message}). You can still watch it at ${doc.url}`
        }).catch(console.error);
        // Rethrow so the dataroom summary counts it among the failures.
        throw error;
      }
      return;
    }
    console.log(`Dataroom document ${index + 1}/${total} "${doc.title}": ${doc.screenshots.length} pages, creating PDF...`);
    const pdfBuffer = await createPDFFromScreenshots(doc.screenshots);
    console.log('PDF buffer size:', pdfBuffer.length, 'bytes');
    await uploadPdf({
      channel, threadTs, pdfBuffer,
      filename: pdfFilename(doc.title, `${docId}-${index + 1}`),
      title: doc.title,
      initialComment: `${index + 1}/${total}: *${doc.title}*${doc.folder ? ` (${doc.folder})` : ''}${dataroomTypeNote(doc.type)}`
    });
  };

  enqueueConversion(() => convert(docUrl, messageText, { ...convertOpts, onDocument })
    .then(async (result) => {
      if (result && result.dataroom) {
        const webLinks = result.documents.filter(d => d.webLink);
        const converted = result.documents.filter(d => !d.error && !d.webLink);
        const failed = result.documents.filter(d => d.error);
        const videos = converted.filter(d => d.video).length;
        console.log(`Dataroom "${result.title}": ${converted.length} converted (${videos} videos), ${failed.length} failed, ${webLinks.length} web links`);
        const lines = [
          `Converted ${converted.length} of ${result.documents.length} entr${result.documents.length === 1 ? 'y' : 'ies'} from the DocSend dataroom *${result.title}*` +
          (videos > 0 ? ` (${videos} of them ${videos === 1 ? 'is a video' : 'are videos'}, posted as MP4).` : '.')
        ];
        if (webLinks.length > 0) {
          lines.push(`${webLinks.length} web link${webLinks.length === 1 ? '' : 's'} passed through as-is (see above).`);
        }
        if (failed.length > 0) {
          lines.push(`Couldn't convert ${failed.length}:`);
          failed.forEach(d => lines.push(`• ${d.folder ? `${d.folder} / ` : ''}${d.title}: ${d.error}`));
        }
        await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: lines.join('\n') }).catch(console.error);
        return;
      }

      if (result && result.video) {
        const title = result.title || `DocSend video ${docId}`;
        try {
          await postVideo({
            channel, threadTs, title,
            playlistUrl: result.playlistUrl,
            filename: safeFilename(title, docId, 'mp4'),
            initialComment: `Here is the DocSend video *${title}* as an MP4.`
          });
        } catch (error) {
          error.code = 'VIDEO_FAILED';
          throw error;
        }
        return;
      }

      const screenshots = result;
      if (!screenshots || !Array.isArray(screenshots)) {
        throw new Error(`No screenshots returned from ${provider} conversion`);
      }
      console.log(`Captured ${screenshots.length} pages, creating PDF...`);

      const pdfBuffer = await createPDFFromScreenshots(screenshots);
      if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
        throw new Error('Invalid PDF buffer generated');
      }
      console.log('PDF buffer size:', pdfBuffer.length, 'bytes');

      await uploadPdf({
        channel, threadTs, pdfBuffer,
        filename: `${docId}.pdf`,
        title: `${provider} Document ${docId}`,
        initialComment: `Here is your ${provider} document converted to PDF.`
      });
    })
    .catch(async (error) => {
      if (error.code === 'EMAIL_VERIFICATION_REQUIRED') {
        parkConversion('verify', {
          channel, threadTs, provider, convert, docUrl, docId, messageText,
          cookies: error.cookies, email: convertOpts.email
        });
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: [
            `This link requires email verification, so I can't open it on my own.`,
            `DocSend just emailed a verification link to *${error.email}*.`,
            `*:warning: DO NOT OPEN OR CLICK THE LINK IN THAT EMAIL.* It only works once, and I need to be the one who opens it.`,
            `Instead, copy the link from the email and paste it here in this thread. You have 30 minutes; after that, post the DocSend link again for a fresh one.`,
            EMAIL_OVERRIDE_HINT(error.email)
          ].join('\n')
        }).catch(console.error);
        return;
      }

      if (error.code === 'EMAIL_REQUIRED') {
        parkConversion('email', {
          channel, threadTs, provider, convert, docUrl, docId, messageText,
          cookies: error.cookies, email: null
        });
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: [
            `This link asks for an email address, and I couldn't read yours from your Slack profile.`,
            `Reply here in this thread with the email address the document was shared with (DocSend may send a verification link there, which you'd then paste here unopened). You have 30 minutes.`
          ].join('\n')
        }).catch(console.error);
        return;
      }

      if (error.code === 'PASSCODE_REQUIRED') {
        parkConversion('passcode', {
          channel, threadTs, provider, convert, docUrl, docId, messageText,
          cookies: error.cookies, email: convertOpts.email
        });
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: [
            `This link needs a passcode and none was included.`,
            `Reply here in this thread with just the passcode and I'll continue. You have 30 minutes.`,
            `(Next time you can include it with the link as \`pw:THEPASSCODE\`.)`
          ].join('\n')
        }).catch(console.error);
        return;
      }

      if (/rejected the passcode/.test(error.message || '')) {
        parkConversion('passcode', {
          channel, threadTs, provider, convert, docUrl, docId,
          messageText: messageText.replace(/\s*pw:\S+/gi, ''),
          cookies: convertOpts.cookies, email: convertOpts.email
        });
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `That passcode didn't work. Reply here with the right one and I'll try again.`
        }).catch(console.error);
        return;
      }

      if (error.code === 'VIDEO_FAILED') {
        console.error('Error fetching DocSend video:', error);
        await app.client.chat.postMessage({
          channel, thread_ts: threadTs,
          text: `This DocSend link is a video, and I couldn't fetch it as an MP4: ${error.message}`
        }).catch(console.error);
        return;
      }

      console.error(`Error processing ${provider} document:`, error);
      const text = convertOpts.verifyUrl
        ? `Sorry, that verification link didn't unlock the ${provider} document. It has probably expired or was already clicked, since each link works once. Post the DocSend link again, then paste the new link from the newest email without opening it.`
        : /\/view\/s\//.test(docUrl)
          ? `Sorry, I couldn't convert the DocSend dataroom: ${error.message}`
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

      // A reply in a thread where a conversion is parked: a verification
      // link, a passcode, or a different email address finishes it.
      const replyThreadTs = event.thread_ts || event.message?.thread_ts;
      if (replyThreadTs && !event.bot_id && event.subtype !== 'message_deleted' && messageText) {
        const pending = getPendingPrompt(event.channel, replyThreadTs);
        const reply = pending ? classifyReply(messageText) : null;
        if (pending && reply) {
          const messageKey = `${messageId}_reply_${replyThreadTs}`;
          if (processedMessages.has(messageKey)) {
            console.log('Thread reply already processed, skipping');
            return;
          }

          let convertOpts = null;
          let messageTextForRetry = pending.messageText;
          let ack = null;
          if (reply.kind === 'link' && pending.kind === 'verify') {
            convertOpts = { verifyUrl: reply.url, cookies: pending.cookies, email: pending.email };
            ack = 'Got the verification link, finishing the conversion...';
          } else if (reply.kind === 'email') {
            // Start over with that address: a verification link, if needed,
            // then goes to that inbox.
            convertOpts = { email: reply.email };
            ack = `Retrying with *${reply.email}*...`;
          } else if (reply.kind === 'text' && pending.kind === 'passcode') {
            convertOpts = { cookies: pending.cookies, email: pending.email };
            messageTextForRetry = `${pending.messageText} pw:${reply.text.replace(/\s+/g, '')}`;
            ack = 'Got the passcode, continuing...';
          }

          if (convertOpts) {
            markMessageProcessed(messageKey);
            pendingPrompts.delete(pendingKey(event.channel, replyThreadTs));
            console.log(`Thread reply (${reply.kind}) for parked conversion of`, pending.docUrl);

            app.client.chat.postMessage({
              channel: event.channel,
              thread_ts: replyThreadTs,
              text: ack
            }).catch(console.error);

            runConversion({
              channel: event.channel,
              threadTs: replyThreadTs,
              provider: pending.provider,
              convert: pending.convert,
              docUrl: pending.docUrl,
              docId: pending.docId,
              messageText: messageTextForRetry,
              convertOpts
            });
            return;
          }
          console.log(`Ignoring thread reply of kind ${reply.kind} while pending ${pending.kind}`);
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
          // Dataroom roots (/view/s/<space>) use the space id, not "s".
          const dataroomMatch = docsendUrl && docsendUrl.match(/\/view\/s\/([a-zA-Z0-9\-_]+)/);
          const isDataroom = !!dataroomMatch;
          const docId = dataroomMatch
            ? dataroomMatch[1]
            : docsendUrl
              ? (docsendUrl.includes('/view/')
                  ? docsendUrl.split('/view/')[1].split('/')[0]
                  : docsendUrl.split('/v/')[1].split('/')[0])
              : pitchUrl.split('/').filter(Boolean).pop();
          console.log('Extracted document ID:', docId, isDataroom ? '(dataroom)' : '');

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
              : isDataroom
                ? 'Converting every document in the DocSend dataroom (PDFs, and videos as MP4)...'
                : `Converting ${provider} document to PDF...`,
            thread_ts: threadTs
          }).catch(console.error);

          // Convert to screenshots and create PDF, one document at a time,
          // entering the poster's own email at DocSend's gate when known.
          const posterId = event.user || event.message?.user;
          lookupPosterEmail(posterId).then((posterEmail) => {
            if (posterEmail) console.log(`Using poster's email for DocSend gates: ${posterEmail}`);
            else console.log('Poster email unknown; the bot will ask in the thread if the link has an email gate');
            runConversion({
              channel: event.channel, threadTs, provider, convert, docUrl, docId, messageText,
              convertOpts: { email: posterEmail || null }
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
