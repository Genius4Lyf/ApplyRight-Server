const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const billingController = require('../controllers/billing.controller');

router.get('/balance', protect, billingController.getBalance);
router.post('/add', protect, billingController.addCredits);
router.post('/usage', protect, billingController.deductCredits);
router.get('/transactions', protect, billingController.getTransactions);

module.exports = router;
