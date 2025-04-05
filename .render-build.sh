#!/usr/bin/env bash
# exit on error
set -o errexit

# Set Puppeteer environment variables
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer

# Create cache directory
mkdir -p $PUPPETEER_CACHE_DIR

# Install Chrome
apt-get update
apt-get install -y wget gnupg
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list
apt-get update
apt-get install -y google-chrome-stable

# Install Node.js dependencies
npm install 