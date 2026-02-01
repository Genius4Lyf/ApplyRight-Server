const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const billingController = require('../controllers/billing.controller');

router.get('/balance', protect, billingController.getBalance);
router.post('/add', protect, billingController.addCredits);
router.post('/usage', protect, billingController.deductCredits);
router.get('/transactions', protect, billingController.getTransactions);
router.post('/watch-ad', protect, billingController.watchAd);
router.post('/verify-payment', protect, billingController.verifyPayment);
router.get('/ad-stats', protect, billingController.getWatchStats);

module.exports = router;
