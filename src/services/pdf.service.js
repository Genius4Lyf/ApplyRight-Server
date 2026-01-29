const puppeteer = require('puppeteer');

class PdfService {
    constructor() {
        this.browser = null;
    }

    async init() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // Handle shared memory issues in Docker/limited envs
                    '--font-render-hinting=none' // Ensure consistent font rendering
                ]
            });
        }
    }

    async generatePdf(htmlContent, options = {}) {
        await this.init();
        const page = await this.browser.newPage();

        try {
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
            throw error;
        } finally {
            await page.close();
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

module.exports = new PdfService();
