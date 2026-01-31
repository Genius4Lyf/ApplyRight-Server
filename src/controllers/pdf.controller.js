const PdfService = require('../services/pdf.service');

exports.generateCvPdf = async (req, res) => {
    try {
        const { html, options } = req.body;

        if (!html) {
            return res.status(400).json({ message: 'HTML content is required' });
        }

        // Generate PDF with options
        const buffer = await PdfService.generatePdf(html, options || {});

        // Send PDF response
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': buffer.length,
            'Content-Disposition': `attachment; filename="cv-${Date.now()}.pdf"`
        });

        res.send(buffer);

    } catch (error) {
        console.error('PDF Controller Error:', error);
        res.status(500).json({
            message: 'Failed to generate PDF',
            error: error.message
        });
    }
};
