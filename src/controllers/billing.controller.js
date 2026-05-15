const User = require("../models/User");
const Transaction = require("../models/Transaction");
const adReward = require("../services/adReward.service");
const admobSsv = require("../services/admobSsv.service");
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

    res.json({
      watchCount,
      maxDaily: 999, // Unlimited
      lastWatch: lastWatch ? lastWatch.createdAt : null,
      streak: user.adStreak ? user.adStreak.current : 0,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};
// @desc    Verify Paystack Payment
// @route   POST /api/billing/verify-payment
// @access  Private
exports.verifyPayment = async (req, res) => {
  const { reference } = req.body;

  try {
    if (!reference) {
      return res.status(400).json({ message: "No transaction reference provided" });
    }

    // 1. Verify with Paystack API
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    if (!data.status || data.data.status !== "success") {
      return res.status(400).json({ message: "Transaction verification failed" });
    }

    const { amount, metadata } = data.data; // Amount is in Kobo (NGN * 100)

    // 2. Check if transaction already exists
    const existingTx = await Transaction.findOne({ reference });
    if (existingTx) {
      return res.status(400).json({ message: "Transaction already verified" });
    }

    const user = await User.findById(req.user.id);

    // 3. Calculate Credits (Simulated logic based on amount paid)
    // Adjust these rates as needed. Current packages:
    // 50 Credits = NGN 2000 roughly? Let's assume metadata carries the credit amount for safety,
    // or we map exact amounts to credits.
    // Ideally, pass 'credits' in metadata from frontend.

    let creditsToAdd = 0;
    if (metadata && metadata.credits) {
      creditsToAdd = parseInt(metadata.credits, 10);
    } else {
      // Fallback mapper (e.g. 1 NGN = 0.05 credits? User buys packages)
      // 20 Credits = $5 (~5000 NGN)
      // 50 Credits = $10 (~10000 NGN)
      // 150 Credits = $25 (~25000 NGN)
      // Using a safe fallback if frontend metadata fails
      creditsToAdd = Math.floor(amount / 100 / 200); // 1 credit per 200 NGN rough estimate
    }

    // 4. Update User Balance
    user.credits += creditsToAdd;
    user.hasEverPurchased = true;
    await user.save({ validateBeforeSave: false });

    // 5. Record Transaction
    await Transaction.create({
      userId: user.id,
      amount: creditsToAdd, // Store credits amount, not currency amount for internal consistency
      type: "purchase",
      description: `Purchased ${creditsToAdd} Credits`,
      status: "completed",
      reference: reference, // Paystack Ref
      paymentGateway: "paystack",
    });

    res.json({
      success: true,
      credits: user.credits,
      added: creditsToAdd,
      message: "Payment verified successfully",
    });
  } catch (error) {
    console.error("Payment Verification Error:", error);
    res.status(500).json({ message: "Payment verification failed server error" });
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
