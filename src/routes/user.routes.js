const express = require("express");
const router = express.Router();
const { protect: auth } = require("../middleware/auth.middleware");
const userController = require("../controllers/user.controller");

// @route   GET api/users/profile
// @desc    Get current user profile
// @access  Private
router.get("/profile", auth, userController.getProfile);

// @route   PUT api/users/profile
// @desc    Update user profile
// @access  Private
router.put("/profile", auth, userController.updateProfile);

// @route   DELETE api/users/profile
// @desc    Delete user account and all associated PII data
// @access  Private
router.delete("/profile", auth, userController.deleteProfile);

module.exports = router;
