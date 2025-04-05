require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');

// Initialize Express app
const expressApp = express();
const port = process.env.PORT || 10000;

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  customRoutes: [
    {
      path: '/slack/events',
      method: ['POST'],
      handler: (req, res) => {
        if (req.body.type === 'url_verification') {
          res.json({ challenge: req.body.challenge });
        } else {
          app.processEvent(req.body);
          res.status(200).send();
        }
      }
    }
  ]
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
    await app.start();
    console.log('⚡️ Bolt app is running!');
  } catch (error) {
    console.error('Error starting Slack app:', error);
    server.close();
    process.exit(1);
  }
})(); 