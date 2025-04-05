#!/usr/bin/env bash
# exit on error
set -o errexit

# Set Puppeteer environment variables
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

# Install Node.js dependencies
npm install --legacy-peer-deps 