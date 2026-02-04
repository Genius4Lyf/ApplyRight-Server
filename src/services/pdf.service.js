const puppeteer = require('puppeteer');

class PdfService {
    constructor() {
        this.browser = null;
    }

    async init() {
        if (!this.browser) {
            try {
                // Configure launch options for Render/Production environments
                const launchOptions = {
                    headless: true, // Use new headless mode (or 'shell' in newer versions)
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--font-render-hinting=none',
                        '--single-process', // Sometimes helps in resource-constrained envs
                        '--no-zygote'
                    ],
                    // executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null // Fallback if env var is set
                };

                console.log('Launching Puppeteer with options:', JSON.stringify(launchOptions));

                this.browser = await puppeteer.launch(launchOptions);

                this.browser.on('disconnected', () => {
                    console.warn('Puppeteer browser disconnected. Resetting instance.');
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
        try {
            await this.init();

            if (!this.browser) {
                throw new Error("Browser instance not initialized");
            }

            page = await this.browser.newPage();

            // Set content with options
            await page.setContent(htmlContent, {
                waitUntil: ['load', 'networkidle0'], // Wait for external resources like fonts/images
                timeout: 30000
            });

            // Specific PDF options for CVs
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true, // Essential for resume colors/bg
                displayHeaderFooter: true, // Required for margins to work
                headerTemplate: '<div></div>', // Empty header
                footerTemplate: '<div></div>', // Empty footer
                margin: options.margin || {
                    top: '0px',
                    right: '0px',
                    bottom: '0px',
                    left: '0px'
                },
                ...options
            });

            return pdfBuffer;
        } catch (error) {
            console.error('Puppeteer PDF Generation Error:', error);
            // If critical error, maybe close browser to force restart next time
            if (this.browser) {
                await this.close();
            }
            throw new Error("Failed to generate PDF document");
        } finally {
            if (page) {
                try {
                    await page.close();
                } catch (e) {
                    console.error("Error closing page:", e);
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
