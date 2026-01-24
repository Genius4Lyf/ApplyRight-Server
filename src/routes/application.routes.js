const express = require('express');
const router = express.Router();
const { getApplications, deleteApplication } = require('../controllers/application.controller');
const { protect } = require('../middleware/auth.middleware');

router.get('/', protect, getApplications);
router.delete('/:id', protect, deleteApplication);

module.exports = router;
