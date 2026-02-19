const express = require('express');
const router = express.Router();
const { registerUser, loginUser, getMe, updateProfile, forgotPassword, resetPassword, registerAdmin } = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');

router.post('/register', registerUser);
router.post('/register-secret-admin', registerAdmin); // Obscured route name in verifying logic, but public endpoint needs to be known by frontend
router.post('/login', loginUser);
router.post('/forgotpassword', forgotPassword);
router.post('/resetpassword', resetPassword);
router.get('/me', protect, getMe);
router.put('/profile', protect, updateProfile);

module.exports = router;
