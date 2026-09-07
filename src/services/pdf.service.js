const { puppeteer, getLaunchOptions, isProduction } = require("./browser");

class PdfService {
  constructor() {
    this.browser = null;
    // The in-flight launch, so concurrent callers await ONE browser instead of each
    // starting their own. `init()` only checked `this.browser`, which is still null
    // while a launch is in progress — so two downloads at the same moment both saw null
    // and both called puppeteer.launch(). The second assignment won and the first
    // Chromium was orphaned: never closed, never reachable, holding its memory until the
    // process died. On a small Render instance a handful of simultaneous downloads is
    // enough to OOM the backend, which takes out every request, not just the PDFs.
    this.launching = null;
  }

  async init() {
    if (this.browser) return;
    if (this.launching) return this.launching;
    this.launching = this._launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  async _launch() {
    if (!this.browser) {
      const launchOptions = await getLaunchOptions();

      try {
        console.log(
          `Launching Puppeteer (${isProduction ? "production" : "local"}) with options:`,
          JSON.stringify(launchOptions)
        );

        this.browser = await puppeteer.launch(launchOptions);

        this.browser.on("disconnected", () => {
          console.warn("Puppeteer browser disconnected. Resetting instance.");
          this.browser = null;
        });
      } catch (error) {
        console.error("Failed to launch Puppeteer:", error);
        throw new Error(`PDF Generation Service Unavailable: ${error.message}`);
      }
    }
  }

  async generatePdf(htmlContent, options = {}) {
    let page = null;
    console.log("--- [PdfService] generatePdf started ---");
    try {
      await this.init();
      console.log("--- [PdfService] Browser initialized ---");

      if (!this.browser) {
        throw new Error("Browser instance not initialized");
      }

      page = await this.browser.newPage();
      console.log("--- [PdfService] New page created ---");

      // Set content with options
      console.log("--- [PdfService] Setting page content... ---");
      await page.setContent(htmlContent, {
        waitUntil: "domcontentloaded", // Use domcontentloaded to avoid frame detachment from external scripts
        timeout: 30000,
      });

      // Wait for fonts to actually finish loading (capped, so a stuck/blocked
      // font CDN can't hang PDF generation forever)
      await Promise.race([
        page.evaluate(() => document.fonts.ready.then(() => true)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      console.log("--- [PdfService] Page content set. Generating PDF... ---");

      // Specific PDF options for CVs
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true, // Essential for resume colors/bg
        displayHeaderFooter: true, // Required for margins to work
        headerTemplate: "<div></div>", // Empty header
        footerTemplate: "<div></div>", // Empty footer
        preferCSSPageSize: true, // Respect @page CSS margin rules
        margin: options.margin || {
          top: "0px",
          right: "25px",
          bottom: "25px",
          left: "25px",
        },
        ...options,
      });

      console.log("--- [PdfService] PDF Buffer generated ---");
      return pdfBuffer;
    } catch (error) {
      console.error("--- [PdfService] Puppeteer Error:", error);
      // If critical error, maybe close browser to force restart next time
      if (this.browser) {
        console.log("--- [PdfService] Closing browser due to error ---");
        await this.close();
      }
      throw new Error(`Failed to generate PDF document: ${error.message}`);
    } finally {
      if (page) {
        try {
          await page.close();
          console.log("--- [PdfService] Page closed ---");
        } catch (e) {
          console.error("--- [PdfService] Error closing page:", e);
        }
      }
    }
  }

  async close() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {
        console.error("Error closing browser:", e);
      }
      this.browser = null;
    }
  }
}

module.exports = new PdfService();
