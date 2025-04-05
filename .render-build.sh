#!/usr/bin/env bash
# exit on error
set -o errexit

# Install Chrome for Puppeteer
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/opt/render/project/.apt/usr/bin/google-chrome

# Install Chrome first
mkdir -p /opt/render/project/.apt
apt-get update
apt-get install -y wget gnupg
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list
apt-get update
apt-get install -y google-chrome-stable

# Create symlink to Chrome
mkdir -p /opt/render/project/.apt/usr/bin
ln -s /usr/bin/google-chrome /opt/render/project/.apt/usr/bin/google-chrome

# Install Node.js dependencies
npm install 