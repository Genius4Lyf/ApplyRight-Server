const crypto = require("crypto");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Payment = require("../models/Payment");
const adReward = require("../services/adReward.service");
const admobSsv = require("../services/admobSsv.service");
const flutterwave = require("../services/flutterwave.service");
const subscription = require("../services/subscription.service");
const { getItem, FREE_TASTE_SEC } = require("../config/catalog");
const env = require("../config/env");
const logger = require("../utils/logger");

// @desc    Get current user credit balance
// @route   GET /api/billing/balance
// @access  Private
exports.getBalance = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ credits: user.credits });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Add credits to user (Simulated Payment / Admin)
// @route   POST /api/billing/add
// @access  Private (Should be Admin or Webhook, but keeping Private for prototype)
exports.addCredits = async (req, res) => {
  const { amount, description } = req.body;

  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.credits += parseInt(amount, 10);
    await user.save({ validateBeforeSave: false });

    // Record Transaction
    await Transaction.create({
      userId: user.id,
      amount: amount,
      type: "purchase",
      description: description || "Credit Top-up",
      status: "completed",
    });

    res.json({ message: "Credits added successfully", credits: user.credits });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Deduct credits for usage (Internal Service Call)
// @route   POST /api/billing/usage
// @access  Private
exports.deductCredits = async (req, res) => {
  const { cost, serviceName } = req.body;

  try {
    const user = await User.findById(req.user.id);

    if (user.credits < cost) {
      return res
        .status(400)
        .json({ message: "Insufficient credits", error: "INSUFFICIENT_CREDITS" });
    }

    user.credits -= parseInt(cost, 10);
    await user.save({ validateBeforeSave: false });

    // Record Transaction
    await Transaction.create({
      userId: user.id,
      amount: -cost, // Negative for deduction
      type: "usage",
      description: `Used for ${serviceName}`,
      status: "completed",
    });

    res.json({ success: true, credits: user.credits });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get transaction history
// @route   GET /api/billing/transactions
// @access  Private
exports.getTransactions = async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(transactions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Watch Ad Reward (Monetag link-out on web)
// @route   POST /api/billing/watch-ad
// @access  Private
exports.watchAd = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const watchCount = await Transaction.countDocuments({
      userId: user._id,
      type: "ad_reward",
      status: "completed",
      createdAt: { $gte: today },
    });

    const result = await adReward.awardAdCredits(user, {
      source: "monetag",
      amount: 5,
    });

    if (!result.ok) {
      if (result.code === "COOLDOWN") {
        const retryAfter = Math.ceil(result.retryAfterMs / 1000);
        res.set("Retry-After", String(retryAfter));
        return res.status(429).json({
          code: "COOLDOWN",
          message: `Please wait ${retryAfter}s before watching another ad.`,
          retryAfterMs: result.retryAfterMs,
        });
      }
      if (result.code === "DAILY_CAP") {
        return res.status(429).json({
          code: "DAILY_CAP",
          message: "Daily ad limit reached. Come back tomorrow!",
        });
      }
      return res.status(400).json({ message: "Reward rejected" });
    }

    res.json({
      success: true,
      credits: result.credits,
      added: result.added,
      watchCount: watchCount + 1,
      maxDaily: env.ADMOB_DAILY_CAP,
      streak: result.streak,
      streakBonus: result.streakBonus,
      streakMessage: result.streakMessage,
      type: "monetag",
    });
  } catch (error) {
    logger.error(`watchAd error: ${error.message}\n${error.stack}`);
    res.status(500).json({ message: "Server Error", detail: error.message });
  }
};

// @desc    AdMob Server-Side Verification callback
// @route   GET /api/billing/admob-ssv
// @access  Public (called by Google)
//
// Always returns 200 for business-logic rejections (cooldown, cap, unknown
// user, duplicate transaction) so Google does not retry. 403 only on a
// signature failure — those should never be real Google traffic.
exports.admobSsv = async (req, res) => {
  try {
    const rawQs = (req.originalUrl.split("?")[1] || "").trim();
    logger.info(`AdMob SSV callback received: ip=${req.ip} qs=${rawQs}`);
    const verification = await admobSsv.verifySignature(rawQs);
    if (!verification.valid) {
      logger.warn(`AdMob SSV signature rejected: ${verification.reason} qs=${rawQs}`);
      return res.status(403).send("invalid signature");
    }

    const params = verification.params;
    const userId = params.get("user_id");
    const txId = params.get("transaction_id");
    const adUnit = params.get("ad_unit");

    if (!userId || !txId) {
      logger.warn(`AdMob SSV missing user_id or transaction_id: qs=${rawQs}`);
      return res.status(200).send("ok");
    }

    // Optional ad-unit allowlist
    if (env.ADMOB_REWARDED_UNIT_ID_ALLOWLIST) {
      const allowed = env.ADMOB_REWARDED_UNIT_ID_ALLOWLIST.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.length > 0 && adUnit && !allowed.includes(adUnit)) {
        logger.warn(`AdMob SSV ad_unit not in allowlist: ${adUnit}`);
        return res.status(200).send("ok");
      }
    }

    // Idempotency: short-circuit if we already recorded this transaction
    const existing = await Transaction.findOne({ externalTxId: txId });
    if (existing) {
      return res.status(200).send("ok");
    }

    const user = await User.findById(userId).catch(() => null);
    if (!user) {
      logger.warn(`AdMob SSV user not found: ${userId}`);
      return res.status(200).send("ok");
    }

    const result = await adReward.awardAdCredits(user, {
      source: "admob",
      amount: env.ADMOB_REWARD_AMOUNT_ANDROID,
      externalTxId: txId,
    });

    if (!result.ok) {
      logger.info(`AdMob SSV rejected ${userId}: ${result.code}`);
    } else {
      logger.info(`AdMob SSV awarded ${result.added} credits to ${userId} (tx=${txId})`);
    }

    return res.status(200).send("ok");
  } catch (error) {
    logger.error(`admobSsv error: ${error.message}\n${error.stack}`);
    // Return 200 to avoid Google retries on transient internal errors
    return res.status(200).send("ok");
  }
};

// @desc    Get Ad Watch Stats
// @route   GET /api/billing/ad-stats
// @access  Private
exports.getWatchStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const watchCount = await Transaction.countDocuments({
      userId: req.user.id,
      type: "ad_reward",
      createdAt: { $gte: today },
    });

    // Find last watch time for cooldown (Phase 2)
    const lastWatch = await Transaction.findOne({
      userId: req.user.id,
      type: "ad_reward",
      createdAt: { $gte: today },
    }).sort({ createdAt: -1 });

    const user = await User.findById(req.user.id);

    // Remaining per-user ad cooldown (matches the check in awardAdCredits) so the
    // client can block a watch the grant would reject, instead of letting the
    // user watch an ad for nothing.
    const cooldownSeconds = env.ADMOB_COOLDOWN_SECONDS || 60;
    const lastAt = user?.adWatch?.lastAt ? new Date(user.adWatch.lastAt).getTime() : 0;
    const cooldownRemainingMs = lastAt
      ? Math.max(0, cooldownSeconds * 1000 - (Date.now() - lastAt))
      : 0;

    res.json({
      watchCount,
      maxDaily: 999, // Unlimited
      lastWatch: lastWatch ? lastWatch.createdAt : null,
      streak: user.adStreak ? user.adStreak.current : 0,
      cooldownSeconds,
      cooldownRemainingMs,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};
// @desc    Unlock a template
// @route   POST /api/billing/unlock-template
// @access  Private
exports.unlockTemplate = async (req, res) => {
  const { templateId, cost } = req.body;

  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if already unlocked
    if (user.unlockedTemplates && user.unlockedTemplates.includes(templateId)) {
      return res.status(200).json({
        success: true,
        message: "Template already unlocked",
        credits: user.credits,
        unlockedTemplates: user.unlockedTemplates,
      });
    }

    const costAmount = parseInt(cost, 10);
    // Check balance
    if (user.credits < costAmount) {
      return res
        .status(400)
        .json({ message: "Insufficient credits", error: "INSUFFICIENT_CREDITS" });
    }

    // Deduct credits
    user.credits -= costAmount;

    // Add to unlocked
    if (!user.unlockedTemplates) {
      user.unlockedTemplates = [];
    }
    user.unlockedTemplates.push(templateId);

    await user.save({ validateBeforeSave: false });

    // Record Transaction
    await Transaction.create({
      userId: user.id,
      amount: -costAmount,
      type: "usage",
      description: `Unlocked template: ${templateId}`,
      status: "completed",
    });

    res.json({ success: true, credits: user.credits, unlockedTemplates: user.unlockedTemplates });
  } catch (error) {
    console.error("Unlock Template Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

// ---------------------------------------------------------------------------
// Flutterwave one-time payments (subscription tiers + minute top-ups)
// ---------------------------------------------------------------------------

// Shared helper: build the entitlement snapshot the client UI needs.
const entitlementFor = (user) => {
  const tier = subscription.getEffectiveTier(user);
  const li = user.liveInterview || {};
  const freeTasteRemaining = Math.max(0, FREE_TASTE_SEC - (li.freeTasteUsedSec || 0));
  const dl = subscription.downloadStatus(user);
  return {
    tier,
    plan: user.plan,
    expiresAt: user.subscription?.expiresAt || null,
    planId: user.subscription?.planId || null,
    minutesRemaining: Math.floor((li.secondsRemaining || 0) / 60),
    secondsRemaining: li.secondsRemaining || 0,
    freeTasteRemainingSec: tier === "free" ? freeTasteRemaining : 0,
    model: subscription.modelForUser(user),
    downloads: {
      unlimited: dl.unlimited,
      passRemaining: dl.passRemaining,
      freeAvailable: dl.freeAvailable,
    },
  };
};

// @desc    Start a Flutterwave checkout for a catalog item
// @route   POST /api/billing/checkout
// @access  Private
exports.createCheckout = async (req, res) => {
  try {
    const { planId, currency } = req.body || {};
    const item = getItem(planId);
    if (!item) {
      return res.status(400).json({ message: "Unknown plan", code: "UNKNOWN_PLAN" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const selectedCurrency = currency === "USD" ? "USD" : "NGN";

    // Our reference — also the create-idempotency key on the Payment row.
    const txRef = `AR-${crypto.randomUUID()}`;
    await Payment.create({
      userId: user._id,
      amountNgn: item.amountNgn, // from catalog, never the client
      currency: selectedCurrency,
      flwTxRef: txRef,
      status: "pending",
      purpose: item.purpose,
      planId: item.id,
    });

    const redirectUrl = `${env.FRONTEND_URL || ""}/billing/return`;
    const { link } = await flutterwave.buildCheckout({
      user,
      item,
      txRef,
      redirectUrl,
      currency: selectedCurrency,
    });

    return res.status(200).json({ link, txRef });
  } catch (error) {
    if (error.code === "FLW_UNAVAILABLE") {
      return res
        .status(503)
        .json({ message: "Payments are temporarily unavailable.", code: "FLW_UNAVAILABLE" });
    }
    console.error("createCheckout error:", error.message);
    return res.status(500).json({ message: "Failed to start checkout" });
  }
};

// Core verify+grant, shared by the webhook and the redirect fallback. Idempotent.
// Returns { granted, payment } or throws on provider/verify failure.
const settlePayment = async (payment, flwTransactionId) => {
  // Already settled — short-circuit (idempotent).
  if (payment.status === "successful" && payment.grantedAt) {
    return { granted: false, payment };
  }

  const verify = await flutterwave.verifyTransaction(flwTransactionId);

  const item = getItem(payment.planId);
  const expectedAmount = payment.currency === "USD" ? item?.amountUsd : payment.amountNgn;
  const expectedCurrency = payment.currency || "NGN";

  const ok =
    verify.status === "successful" &&
    verify.currency === expectedCurrency &&
    verify.txRef === payment.flwTxRef &&
    Number(verify.amount) >= Number(expectedAmount);

  if (!ok) {
    payment.status = "failed";
    payment.raw = verify.raw || {};
    await payment.save();
    logger.warn(
      `Flutterwave settle rejected txRef=${payment.flwTxRef} status=${verify.status} amount=${verify.amount}`
    );
    return { granted: false, payment };
  }

  payment.flwTransactionId = verify.id;
  payment.status = "successful";
  payment.raw = verify.raw || {};
  await payment.save();

  const granted = await subscription.grantEntitlement(payment);
  return { granted, payment };
};

// @desc    Flutterwave webhook (payment.completed)
// @route   POST /api/billing/flutterwave-webhook
// @access  Public (verified via verif-hash shared secret)
//
// Always 200 on business-logic rejections so Flutterwave stops retrying; 401 only
// on a bad signature. Mirrors the AdMob SSV handler's response discipline.
exports.flutterwaveWebhook = async (req, res) => {
  try {
    const sigHeader = req.headers["verif-hash"] || "";
    const secret = env.FLW_SECRET_HASH || "";
    // Constant-time compare; reject if not configured or mismatched.
    const a = Buffer.from(String(sigHeader));
    const b = Buffer.from(String(secret));
    if (!secret || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      logger.warn("Flutterwave webhook: invalid verif-hash");
      return res.status(401).send("invalid signature");
    }

    const data = req.body?.data || {};
    const txRef = data.tx_ref;
    const flwId = data.id;
    if (!txRef || flwId == null) return res.status(200).send("ok");

    const payment = await Payment.findOne({ flwTxRef: txRef });
    if (!payment) return res.status(200).send("ok"); // not ours

    await settlePayment(payment, flwId);
    return res.status(200).send("ok");
  } catch (error) {
    logger.error(`flutterwaveWebhook error: ${error.message}`);
    // 200 to avoid retries on transient internal errors; redirect fallback covers us.
    return res.status(200).send("ok");
  }
};

// @desc    Verify a payment on redirect-return (webhook fallback)
// @route   POST /api/billing/verify
// @access  Private
exports.verifyPaymentRedirect = async (req, res) => {
  try {
    const { txRef, transactionId } = req.body || {};
    if (!txRef) return res.status(400).json({ message: "Missing txRef" });

    const payment = await Payment.findOne({ flwTxRef: txRef });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    if (String(payment.userId) !== String(req.user.id)) {
      return res.status(401).json({ message: "Not authorized" });
    }

    if (payment.status !== "successful") {
      // transactionId from the redirect query lets us verify even if the webhook
      // hasn't landed yet. Fall back to the stored id if the webhook beat us.
      const flwId = transactionId || payment.flwTransactionId;
      if (flwId != null) await settlePayment(payment, flwId);
    }

    const user = await User.findById(req.user.id);
    return res.status(200).json({
      status: payment.status,
      entitlement: entitlementFor(user),
    });
  } catch (error) {
    if (error.code === "FLW_UNAVAILABLE") {
      return res.status(503).json({ message: "Could not verify payment yet.", code: "FLW_UNAVAILABLE" });
    }
    console.error("verifyPaymentRedirect error:", error.message);
    return res.status(500).json({ message: "Failed to verify payment" });
  }
};

// @desc    Current subscription/minute entitlement
// @route   GET /api/billing/entitlement
// @access  Private
exports.getEntitlement = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.status(200).json(entitlementFor(user));
  } catch (error) {
    console.error("getEntitlement error:", error.message);
    return res.status(500).json({ message: "Server Error" });
  }
};
