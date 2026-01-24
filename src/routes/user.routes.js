const express = require('express');
const router = express.Router();
const { protect: auth } = require('../middleware/auth.middleware');
const userController = require('../controllers/user.controller');

// @route   GET api/users/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', auth, userController.getProfile);

// @route   PUT api/users/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, userController.updateProfile);

module.exports = router;
