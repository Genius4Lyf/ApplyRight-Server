const { join } = require("path");

/**
 * Pin Puppeteer's browser cache to a project-local directory so that the
 * build step (`npx puppeteer browsers install chrome`) and the runtime
 * (`puppeteer.launch`) resolve to the SAME path on Render.
 *
 * Without this, install downloads to $HOME/.cache/puppeteer while the running
 * server looks in /opt/render/project/src/.cache/puppeteer → "Could not find Chrome".
 */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
