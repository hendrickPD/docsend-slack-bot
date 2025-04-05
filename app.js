require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');

// Initialize Express app
const expressApp = express();
expressApp.use(express.json());

// Health check endpoint
expressApp.get('/', (req, res) => {
  res.send('DocSend to PDF Slack Bot is running!');
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  customRoutes: [
    {
      path: '/slack/events',
      method: ['POST'],
      handler: (req, res) => {
        // Handle Slack's challenge verification
        if (req.body.type === 'url_verification') {
          res.json({ challenge: req.body.challenge });
          return;
        }
        // Handle other events
        app.processEvent(req.body);
        res.status(200).send();
      }
    }
  ]
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