const express = require('express');
const router = express.Router();
const { getApplications, updateTemplate, deleteApplication } = require('../controllers/application.controller');
const { protect } = require('../middleware/auth.middleware');

router.get('/', protect, getApplications);
router.patch('/:id/template', protect, updateTemplate);
router.delete('/:id', protect, deleteApplication);

module.exports = router;
