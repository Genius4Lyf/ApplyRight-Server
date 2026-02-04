#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# Ensure Puppeteer browsers are installed
# This will use the cache directory defined in puppeteer.config.cjs
npx puppeteer browsers install chrome
