const puppeteer = require('puppeteer');

class PdfService {
    constructor() {
        this.browser = null;
    }

    async init() {
        if (!this.browser) {
            try {
                this.browser = await puppeteer.launch({
                    headless: 'new',
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage', // Handle shared memory issues in Docker/limited envs
                        '--font-render-hinting=none', // Ensure consistent font rendering
                        '--disable-gpu', // Simplify rendering
                    ]
                });

                // Handle browser disconnect/crash to reset the instance
                this.browser.on('disconnected', () => {
                    console.log('Puppeteer browser disconnected. Resetting instance.');
                    this.browser = null;
                });

            } catch (error) {
                console.error("Failed to launch Puppeteer:", error);
                throw new Error("PDF Generation Service Unavailable");
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
                margin: {
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
