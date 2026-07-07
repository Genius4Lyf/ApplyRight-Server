#!/usr/bin/env bash
# exit on error
set -o errexit

# Install production deps only. Chromium is provided by the @sparticuz/chromium
# npm package (a normal dependency), so there is NO separate browser download
# step and nothing lands in a .cache dir that Render would strip at runtime.
npm install --omit=dev

# Sanity check: confirm the Chromium package is present in the runtime deps.
echo "==> Verifying @sparticuz/chromium is installed:"
ls -d node_modules/@sparticuz/chromium || (echo "ERROR: @sparticuz/chromium not installed" && exit 1)
