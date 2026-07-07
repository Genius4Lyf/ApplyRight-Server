#!/usr/bin/env bash
# exit on error
set -o errexit

npm install

# Pin the browser cache to a project-local dir that Render persists from
# build → runtime. Must match cacheDirectory in .puppeteerrc.cjs.
export PUPPETEER_CACHE_DIR="$(pwd)/.cache/puppeteer"
echo "==> PUPPETEER_CACHE_DIR=$PUPPETEER_CACHE_DIR"

# Install the Chrome build that THIS puppeteer version expects.
npx puppeteer browsers install chrome

# Fail the build loudly if Chrome did not actually land in the cache,
# instead of discovering it at runtime.
echo "==> Contents of $PUPPETEER_CACHE_DIR:"
ls -la "$PUPPETEER_CACHE_DIR/chrome" || (echo "ERROR: Chrome was not installed into the cache dir" && exit 1)
