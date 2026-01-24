const express = require('express');
const router = express.Router();
const { generateApplication } = require('../controllers/ai.controller');
const { protect } = require('../middleware/auth.middleware');

router.post('/generate', protect, generateApplication);

module.exports = router;
