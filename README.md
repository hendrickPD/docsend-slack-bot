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
     - `users:read` and `users:read.email` (lets the bot enter the poster's own email at DocSend's email gate, so verification links reach their inbox; without them, or for posters without a profile email, the bot enters `DOCSEND_EMAIL` instead and only asks in the thread when that is unset too)
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
     STATE_CHANNEL_ID=C0123456789   # private channel for crash-resume state (see below)
     ```
   - Optional tuning: `MEMORY_LIMIT_MB`, `MEMORY_PRESSURE_RATIO`, `SLIDE_MAX_WIDTH`, `SLIDE_JPEG_QUALITY` (see "Surviving restarts and memory pressure").

## Surviving restarts and memory pressure

The bot runs on a small instance (512 MB on Render). Three things keep a long dataroom from taking it down:

- **Memory watchdog** (`memory.js`). Usage is read from the container's cgroup (v2, then v1); on macOS or without a cgroup it is this process's RSS plus the Chrome process tree's, against `MEMORY_LIMIT_MB` (default 512). Note that on macOS the Chrome tree's RSS overcounts shared pages, so local runs need a higher limit (a few GB). Polled every 2 s while a conversion runs; when usage passes `MEMORY_PRESSURE_RATIO` (default 0.85) of the limit, the current capture is aborted. In a dataroom the document is skipped ("too large for this instance's memory"), the browser is relaunched to reclaim the memory, the rest of the room continues and the skipped documents are listed in the summary. A single document posts a clear message instead. Usage is logged at the start and end of every document.
- **Smaller pages**. Slide, vertical and spreadsheet captures are re-encoded no wider than `SLIDE_MAX_WIDTH` px (default 1600) at JPEG quality `SLIDE_JPEG_QUALITY` (default 75). Sources already narrower keep their size.
- **Crash resume** (`jobState.js`). Render wipes the filesystem on a restart, so each job's state is kept in Slack: set `STATE_CHANNEL_ID` to the ID of a **private** channel and invite the bot to it (`/invite @your-bot-name`). At job start the bot posts a compact state message there (channel, thread, link, email, the cookies of the authorized DocSend session, and the index of the next document), updates it after every posted document, and deletes it when the job ends. On startup the bot reads that channel's history: for every state message still present it posts in the original thread that the conversion was interrupted by a restart and resumes from the next document with the saved cookies (the usual verification, passcode and email prompts apply if the session no longer works), then deletes the state message. A job that gets interrupted twice is dropped with a message instead of restarting the loop. Keep the channel private: the cookies are the only sensitive content. Without `STATE_CHANNEL_ID` the state goes to marker files under the OS temp directory, which works locally but does not survive a Render restart (logged once at startup).

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

## Testing Locally

To test the bot locally, follow these steps:

1. **Ensure Node.js is Installed:**
   - Make sure you have Node.js installed on your machine. You can check by running:
     ```bash
     node -v
     ```

2. **Clone the Repository:**
   - If you haven't already, clone your repository to your local machine:
     ```bash
     git clone https://github.com/hendrickPD/docsend-slack-bot.git
     cd docsend-slack-bot
     ```

3. **Install Dependencies:**
   - Run the following command to install all dependencies:
     ```bash
     npm install
     ```

4. **Run the Application:**
   - Start the application to see if it runs without issues:
     ```bash
     npm start
     ```

5. **Check for Errors:**
   - Monitor the console output for any errors or warnings.

6. **Test the Bot:**
   - If the application starts successfully, test the bot by sending a DocSend link in your Slack channel.