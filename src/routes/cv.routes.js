const express = require('express');
const router = express.Router();
const { saveDraft, getMyDrafts, getDraftById, deleteDraft } = require('../controllers/cv.controller');
const { protect } = require('../middleware/auth.middleware');

router.post('/save', protect, saveDraft);
router.get('/my-cvs', protect, getMyDrafts);
router.get('/:id', protect, getDraftById);
router.delete('/:id', protect, deleteDraft);

module.exports = router;
