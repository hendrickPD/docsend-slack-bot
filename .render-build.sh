#!/usr/bin/env bash
# exit on error
set -o errexit

# Set Puppeteer environment variables
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
export PUPPETEER_PRODUCT=chrome

# Install Node.js dependencies
npm install 