#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# Ensure Puppeteer browsers are installed (though npm install should handle it)
npx puppeteer browsers install chrome
