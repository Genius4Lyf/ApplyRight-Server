const express = require('express');
const router = express.Router();
const { checkUser, submitFeedback, getAllFeedbacks, promoteToAdmin } = require('../controllers/feedbackController');
const { protect, admin } = require('../middleware/auth.middleware');

router.post('/check-user', checkUser);
router.post('/', submitFeedback);
router.get('/', protect, admin, getAllFeedbacks);
router.post('/promote', protect, promoteToAdmin);

module.exports = router;
