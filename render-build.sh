#!/usr/bin/env bash
# exit on error
set -o errexit

npm install

# Pin the browser cache INSIDE node_modules so it survives Render's
# build -> runtime artifact upload (which strips gitignored dirs like a
# project-root .cache but always keeps node_modules).
# Must match cacheDirectory in .puppeteerrc.cjs.
export PUPPETEER_CACHE_DIR="$(pwd)/node_modules/.cache/puppeteer"
echo "==> PUPPETEER_CACHE_DIR=$PUPPETEER_CACHE_DIR"

# Install the Chrome build that THIS puppeteer version expects.
npx puppeteer browsers install chrome

# Fail the build loudly if Chrome did not actually land in the cache.
echo "==> Contents of $PUPPETEER_CACHE_DIR/chrome:"
ls -la "$PUPPETEER_CACHE_DIR/chrome" || (echo "ERROR: Chrome was not installed into the cache dir" && exit 1)
