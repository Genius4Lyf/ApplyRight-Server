const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const billingController = require("../controllers/billing.controller");

// Public AdMob SSV callback (signature-verified). Must be mounted before
// any auth middleware. Rate-limiter exemption handled in src/app.js.
router.get("/admob-ssv", billingController.admobSsv);

// Public Flutterwave webhook (verified via verif-hash). Before any auth.
// Rate-limiter exemption handled in src/app.js.
router.post("/flutterwave-webhook", billingController.flutterwaveWebhook);

// Flutterwave one-time payments
router.post("/checkout", protect, billingController.createCheckout);
router.post("/verify", protect, billingController.verifyPaymentRedirect);
router.get("/entitlement", protect, billingController.getEntitlement);

router.get("/balance", protect, billingController.getBalance);
router.get("/transactions", protect, billingController.getTransactions);
router.post("/watch-ad", protect, billingController.watchAd);
router.get("/ad-stats", protect, billingController.getWatchStats);
router.post("/unlock-template", protect, billingController.unlockTemplate);

module.exports = router;
