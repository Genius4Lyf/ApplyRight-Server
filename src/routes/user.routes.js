const express = require("express");
const router = express.Router();
const { protect: auth } = require("../middleware/auth.middleware");
const userController = require("../controllers/user.controller");

// @route   GET api/users/profile
// @desc    Get current user profile
// @access  Private
router.get("/profile", auth, userController.getProfile);

// @route   GET api/users/me/referrals
// @desc    Referral code + invites + credits earned (Account hub)
// @access  Private
router.get("/me/referrals", auth, userController.getReferralStats);

// @route   GET api/users/me/stats
// @desc    Activity & progress snapshot (Account hub Overview)
// @access  Private
router.get("/me/stats", auth, userController.getActivityStats);

// @route   PATCH api/users/me/email
// @desc    Change account email (requires current password)
// @access  Private
router.patch("/me/email", auth, userController.changeEmail);

// @route   PATCH api/users/me/password
// @desc    Change account password (requires current password)
// @access  Private
router.patch("/me/password", auth, userController.changePassword);

// @route   GET api/users/me/export
// @desc    Download all user data as JSON
// @access  Private
router.get("/me/export", auth, userController.exportData);

// @route   PUT api/users/profile
// @desc    Update user profile
// @access  Private
router.put("/profile", auth, userController.updateProfile);

// @route   DELETE api/users/profile
// @desc    Delete user account and all associated PII data
// @access  Private
router.delete("/profile", auth, userController.deleteProfile);

module.exports = router;
