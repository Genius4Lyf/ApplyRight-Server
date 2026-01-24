const express = require('express');
const router = express.Router();
const { extractJob, createJobManual } = require('../controllers/job.controller');
const { protect } = require('../middleware/auth.middleware');

router.post('/extract', protect, extractJob);
router.post('/manual', protect, createJobManual);

module.exports = router;
