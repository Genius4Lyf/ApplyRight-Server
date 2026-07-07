const { join } = require("path");

/**
 * Pin Puppeteer's browser cache INSIDE node_modules.
 *
 * Render runs the build in a separate builder and ships an artifact to the
 * runtime. That artifact EXCLUDES gitignored paths (like a project-root
 * `.cache/`) but ALWAYS includes `node_modules`. Installing Chrome under
 * node_modules/.cache/puppeteer is therefore the one location that survives
 * from build time to runtime on Render.
 *
 * Without this, Chrome installs correctly during the build but is stripped
 * from the runtime image → "Could not find Chrome (ver. ...)".
 */
module.exports = {
  cacheDirectory: join(__dirname, "node_modules", ".cache", "puppeteer"),
};
