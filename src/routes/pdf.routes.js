const express = require('express');
const router = express.Router();
const pdfController = require('../controllers/pdf.controller');

// POST /api/pdf/generate
router.post('/generate', pdfController.generateCvPdf);

module.exports = router;
