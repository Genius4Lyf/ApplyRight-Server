// Central Puppeteer/Chromium setup shared by all browser-driven services
// (pdf.service.js, screenshot.service.js, ...).
//
// Production (Render/Linux): puppeteer-core + @sparticuz/chromium. The Chromium
// binary ships AS a normal npm package (node_modules/@sparticuz/chromium), so it
// always survives Render's build -> runtime artifact upload. A Chrome downloaded
// into a .cache dir does NOT survive (Render strips cache dirs), which is why the
// old `npx puppeteer browsers install chrome` approach kept failing at runtime.
//
// Local dev (Windows/macOS): the full `puppeteer` package (a devDependency) with
// its own bundled Chromium, or a custom PUPPETEER_EXECUTABLE_PATH.

const isProduction = process.env.NODE_ENV === "production";

let puppeteer;
let chromium = null;

if (isProduction) {
  puppeteer = require("puppeteer-core");
  chromium = require("@sparticuz/chromium");
  // Disable WebGL/graphics to reduce memory use on constrained instances.
  chromium.setGraphicsMode = false;
} else {
  puppeteer = require("puppeteer");
}

/**
 * Build puppeteer.launch() options for the current environment.
 * @param {string[]} extraArgs Additional Chromium flags to append.
 */
async function getLaunchOptions(extraArgs = []) {
  if (isProduction) {
    return {
      headless: true,
      args: [...chromium.args, "--font-render-hinting=none", ...extraArgs],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
    };
  }

  return {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none",
      ...extraArgs,
    ],
    // If PUPPETEER_EXECUTABLE_PATH is set (e.g. local dev), use it.
    ...(process.env.PUPPETEER_EXECUTABLE_PATH && {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    }),
  };
}

module.exports = { puppeteer, getLaunchOptions, isProduction };
