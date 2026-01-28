const express = require('express');
const router = express.Router();
const { generateApplication } = require('../controllers/ai.controller');
const { protect } = require('../middleware/auth.middleware');

router.post('/generate', protect, generateApplication);
const { generateBullets } = require('../controllers/ai.controller');
router.post('/generate-bullets', protect, generateBullets);

module.exports = router;
