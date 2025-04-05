require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');

// Initialize Express app
const expressApp = express();
expressApp.use(express.json());

// Add request logging middleware
expressApp.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log('Headers:', req.headers);
  console.log('Body:', req.body);
  next();
});

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
        console.log('Received Slack event:', JSON.stringify(req.body));
        
        // Handle Slack's challenge verification
        if (req.body.type === 'url_verification') {
          console.log('Handling challenge verification');
          // Respond with just the challenge value in plaintext
          res.set('Content-Type', 'text/plain');
          res.send(req.body.challenge);
          return;
        }
        
        // Handle other events
        console.log('Processing regular event');
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
  console.log('Environment variables:', {
    hasBotToken: !!process.env.SLACK_BOT_TOKEN,
    hasSigningSecret: !!process.env.SLACK_SIGNING_SECRET
  });
});

// Start the Slack app
app.start().then(() => {
  console.log('Slack app is running!');
}).catch((error) => {
  console.error('Error starting Slack app:', error);
}); 