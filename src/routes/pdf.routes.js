const express = require('express');
const router = express.Router();
const pdfController = require('../controllers/pdf.controller');
const { protect } = require('../middleware/auth.middleware');

// POST /api/pdf/generate
router.post('/generate', protect, pdfController.generateCvPdf);

module.exports = router;
