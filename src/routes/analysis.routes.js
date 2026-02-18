const express = require('express');
const router = express.Router();
const { analyzeFit } = require('../controllers/analysis.controller');
const { protect } = require('../middleware/auth.middleware');

router.post('/analyze', protect, analyzeFit);
router.post('/:id/edit', protect, require('../controllers/analysis.controller').editApplication);

module.exports = router;
