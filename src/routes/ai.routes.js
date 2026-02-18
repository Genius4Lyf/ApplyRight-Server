const express = require('express');
const router = express.Router();
const { generateApplication } = require('../controllers/ai.controller');
const { protect } = require('../middleware/auth.middleware');

router.post('/generate', protect, generateApplication);
const { generateBullets, generateSkills } = require('../controllers/ai.controller');
router.post('/generate-bullets', protect, generateBullets);
router.post('/generate-skills', protect, generateSkills);

module.exports = router;
