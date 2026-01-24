const express = require('express');
const router = express.Router();
const { analyzeFit } = require('../controllers/analysisController');
const { protect } = require('../middleware/auth.middleware');

router.post('/analyze', protect, analyzeFit);

module.exports = router;
