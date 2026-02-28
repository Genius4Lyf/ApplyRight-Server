const puppeteer = require('puppeteer');

const isProduction = process.env.NODE_ENV === 'production';

class PdfService {
    constructor() {
        this.browser = null;
    }

    async init() {
        if (!this.browser) {
            try {
                const args = [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--font-render-hinting=none',
                ];

                // --single-process and --no-zygote help on resource-constrained servers (Render)
                // but cause "Navigating frame was detached" crashes on Windows/local dev
                if (isProduction) {
                    args.push('--single-process', '--no-zygote');
                }

                const launchOptions = {
                    headless: true,
                    args,
                    // If PUPPETEER_EXECUTABLE_PATH is provided in .env (e.g., local development), use it.
                    ...(process.env.PUPPETEER_EXECUTABLE_PATH && { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH })
                };

                console.log(`Launching Puppeteer (${isProduction ? 'production' : 'local'}) with options:`, JSON.stringify(launchOptions));

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
        console.log('--- [PdfService] generatePdf started ---');
        try {
            await this.init();
            console.log('--- [PdfService] Browser initialized ---');

            if (!this.browser) {
                throw new Error("Browser instance not initialized");
            }

            page = await this.browser.newPage();
            console.log('--- [PdfService] New page created ---');

            // Set content with options
            console.log('--- [PdfService] Setting page content... ---');
            await page.setContent(htmlContent, {
                waitUntil: 'domcontentloaded', // Use domcontentloaded to avoid frame detachment from external scripts
                timeout: 30000
            });

            // Give Tailwind CDN and fonts time to process after DOM is ready
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log('--- [PdfService] Page content set. Generating PDF... ---');

            // Specific PDF options for CVs
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true, // Essential for resume colors/bg
                displayHeaderFooter: true, // Required for margins to work
                headerTemplate: '<div></div>', // Empty header
                footerTemplate: '<div></div>', // Empty footer
                preferCSSPageSize: true, // Respect @page CSS margin rules
                margin: options.margin || {
                    top: '0px',
                    right: '25px',
                    bottom: '25px',
                    left: '25px'
                },
                ...options
            });

            console.log('--- [PdfService] PDF Buffer generated ---');
            return pdfBuffer;
        } catch (error) {
            console.error('--- [PdfService] Puppeteer Error:', error);
            // If critical error, maybe close browser to force restart next time
            if (this.browser) {
                console.log('--- [PdfService] Closing browser due to error ---');
                await this.close();
            }
            throw new Error(`Failed to generate PDF document: ${error.message}`);
        } finally {
            if (page) {
                try {
                    await page.close();
                    console.log('--- [PdfService] Page closed ---');
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
