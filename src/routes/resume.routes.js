const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadResume, getResumes } = require('../controllers/resume.controller');
const { protect } = require('../middleware/auth.middleware');

// Multer setup
const upload = multer({ dest: 'uploads/' });

router.post('/upload', protect, upload.single('resume'), uploadResume);
router.get('/', protect, getResumes);

module.exports = router;
