# DocSend to PDF Slack Bot

This Slack bot automatically converts DocSend links shared in your Slack workspace into downloadable PDFs. When a DocSend link is shared in any channel where the bot is present, it will automatically convert the document to PDF and share it in the same thread.

## Features

- Automatically detects DocSend links in messages
- Converts DocSend documents to PDF format
- Shares the PDF directly in the Slack thread
- Maintains document formatting and quality
- Handles authentication with DocSend

## Prerequisites

- Node.js (v14 or higher)
- npm
- A Slack workspace with admin access
- A DocSend account

## Setup

1. **Create a Slack App**
   - Go to [api.slack.com/apps](https://api.slack.com/apps)
   - Click "Create New App" and choose "From scratch"
   - Give your app a name and select your workspace
   - Under "Socket Mode", enable it and create an app-level token
   - Under "OAuth & Permissions", add the following bot token scopes:
     - `chat:write`
     - `files:write`
     - `channels:history`
     - `groups:history`
     - `im:history`
     - `mpim:history`
   - Install the app to your workspace
   - Copy the Bot User OAuth Token, Signing Secret, and App Token

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment Variables**
   - Copy the `.env.example` file to `.env`
   - Fill in your Slack and DocSend credentials:
     ```
     SLACK_BOT_TOKEN=xoxb-your-bot-token
     SLACK_SIGNING_SECRET=your-signing-secret
     SLACK_APP_TOKEN=xapp-your-app-token
     DOCSEND_EMAIL=your-email@example.com
     DOCSEND_PASSWORD=your-password
     ```

## Usage

1. Start the bot:
   ```bash
   node app.js
   ```

2. Invite the bot to any channels where you want it to operate using `/invite @your-bot-name`

3. Share a DocSend link in the channel. The bot will automatically:
   - Detect the DocSend link
   - Convert it to PDF
   - Share the PDF in the thread

## Error Handling

The bot includes error handling for common scenarios:
- Invalid DocSend links
- Authentication failures
- PDF conversion issues
- Network problems

If any errors occur, the bot will respond in the thread with an error message.

## Security Considerations

- Store your credentials securely and never commit them to version control
- Use environment variables for sensitive information
- Regularly rotate your Slack and DocSend credentials
- Monitor the bot's activity for any unusual behavior

## Contributing

Feel free to submit issues and enhancement requests!

## License

MIT License - feel free to use this code in your own projects! 