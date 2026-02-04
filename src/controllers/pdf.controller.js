const PdfService = require('../services/pdf.service');

exports.generateCvPdf = async (req, res) => {
    console.log('--- [PDF Controller] Generate Request Received ---');
    try {
        const { html, options } = req.body;

        if (!html) {
            console.warn('--- [PDF Controller] Missing HTML content in request ---');
            return res.status(400).json({ message: 'HTML content is required' });
        }

        console.log(`--- [PDF Controller] HTML Content Length: ${html.length} chars ---`);
        console.log('--- [PDF Controller] Options:', JSON.stringify(options || {}));

        // Generate PDF with options
        console.log('--- [PDF Controller] Calling PdfService.generatePdf... ---');
        const buffer = await PdfService.generatePdf(html, options || {});
        console.log('--- [PDF Controller] PDF Generation Successful. Buffer size:', buffer.length);

        // Send PDF response
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': buffer.length,
            'Content-Disposition': `attachment; filename="cv-${Date.now()}.pdf"`
        });

        res.send(buffer);
        console.log('--- [PDF Controller] Response sent ---');

    } catch (error) {
        console.error('--- [PDF Controller] Error:', error);
        res.status(500).json({
            message: 'Failed to generate PDF',
            error: error.message,
            stack: error.stack
        });
    }
};
