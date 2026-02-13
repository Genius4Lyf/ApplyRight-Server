const express = require('express');
const router = express.Router();
const { checkUser, submitFeedback, getAllFeedbacks, promoteToAdmin, toggleFeatured, getFeaturedFeedbacks } = require('../controllers/feedbackController');
const { protect, admin } = require('../middleware/auth.middleware');

router.post('/check-user', checkUser);
router.post('/', submitFeedback);
router.get('/', protect, admin, getAllFeedbacks);
router.post('/promote', protect, promoteToAdmin);
router.put('/:id/feature', protect, admin, toggleFeatured);
router.get('/featured', getFeaturedFeedbacks);

module.exports = router;
