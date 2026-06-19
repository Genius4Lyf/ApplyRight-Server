// Entitlement engine — the single place that reasons about a user's paid status,
// grants entitlements after payment, and decides whether a credit charge applies.
// Reused by the webhook, the redirect fallback, the tier middleware, the live
// interview metering, and every text-AI charge site.
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { getItem } = require("../config/catalog");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Effective tier honoring expiry. A subscription whose expiresAt has passed is
 * treated as "free" (lazy expiry — no cron needed).
 */
const getEffectiveTier = (user) => {
  const sub = user?.subscription;
  if (!sub || !sub.expiresAt) return "free";
  if (new Date(sub.expiresAt).getTime() <= Date.now()) return "free";
  return sub.tier || "free";
};

const isPaidActive = (user) => getEffectiveTier(user) !== "free";

/** Premium tier (pro) gets the sharper full model; everyone else the mini model. */
const modelForUser = (user) =>
  getEffectiveTier(user) === "pro" ? "gpt-realtime" : "gpt-realtime-mini";

/**
 * Apply a successful Payment to its user. Idempotent: the guarded updateOne on
 * grantedAt:null ensures a redelivered webhook (or webhook + redirect racing)
 * grants exactly once. Returns true if THIS call performed the grant.
 */
const grantEntitlement = async (payment) => {
  const now = new Date();
  const item = getItem(payment.planId);
  if (!item) throw new Error(`grantEntitlement: unknown planId ${payment.planId}`);

  const minutesSec = (item.minutes || 0) * 60;

  // Idempotency guard: claim the grant. If another delivery already did, bail.
  const claim = await require("../models/Payment").updateOne(
    { _id: payment._id, grantedAt: null },
    {
      $set: {
        grantedAt: now,
        tierGranted: item.tier || null,
        minutesGranted: item.minutes || 0,
      },
    }
  );
  if (claim.modifiedCount === 0) return false; // already granted

  if (item.purpose === "subscription") {
    const expiresAt = new Date(now.getTime() + (item.periodDays || 0) * DAY_MS);
    await User.updateOne(
      { _id: payment.userId },
      {
        $set: {
          plan: "paid",
          tier: item.tier,
          hasEverPurchased: true,
          "subscription.planId": item.id,
          "subscription.tier": item.tier,
          "subscription.status": "active",
          "subscription.source": "flutterwave",
          "subscription.currentPeriodStart": now,
          "subscription.expiresAt": expiresAt,
          // No rollover: a new subscription REPLACES the minute balance.
          "liveInterview.secondsRemaining": minutesSec,
          "liveInterview.periodExpiresAt": expiresAt,
        },
      }
    );
  } else if (item.purpose === "download") {
    // Download pass: add clean-download credits, nothing else.
    await User.updateOne(
      { _id: payment.userId },
      { $inc: { "downloads.passRemaining": item.downloads || 0 } }
    );
  } else {
    // Top-up: add minutes only, leave tier/expiry untouched.
    await User.updateOne(
      { _id: payment.userId },
      { $inc: { "liveInterview.secondsRemaining": minutesSec } }
    );
  }
  return true;
};

/**
 * Snapshot of a user's CV-download entitlement for the UI.
 * Paid tiers download unlimited (PDF gen is ~free for us); free users get one
 * lifetime taste, then ₦500 single-download passes.
 */
const downloadStatus = (user) => {
  const unlimited = isPaidActive(user);
  const passRemaining = user?.downloads?.passRemaining || 0;
  const freeAvailable = !user?.downloads?.freeDownloadUsed;
  return {
    unlimited,
    passRemaining,
    freeAvailable,
    canDownload: unlimited || passRemaining > 0 || freeAvailable,
  };
};

/**
 * Atomically consume one download entitlement. Order: active paid tier (no
 * charge) → a purchased pass → the free lifetime taste. Returns the method used
 * (or ok:false when nothing is available). Atomic guards prevent double-spend
 * across concurrent download requests.
 */
const consumeDownload = async (user) => {
  if (isPaidActive(user)) return { ok: true, method: "subscription" };

  const pass = await User.updateOne(
    { _id: user._id, "downloads.passRemaining": { $gte: 1 } },
    { $inc: { "downloads.passRemaining": -1 } }
  );
  if (pass.modifiedCount === 1) return { ok: true, method: "pass" };

  const free = await User.updateOne(
    { _id: user._id, "downloads.freeDownloadUsed": { $ne: true } },
    { $set: { "downloads.freeDownloadUsed": true } }
  );
  if (free.modifiedCount === 1) return { ok: true, method: "free" };

  return { ok: false };
};

/** Reverse a consume when the PDF fails to generate, so the unit isn't lost. */
const refundDownload = async (user, method) => {
  if (method === "pass") {
    await User.updateOne({ _id: user._id }, { $inc: { "downloads.passRemaining": 1 } });
  } else if (method === "free") {
    await User.updateOne({ _id: user._id }, { $set: { "downloads.freeDownloadUsed": false } });
  }
  // "subscription" consumed nothing → nothing to refund.
};

/**
 * Charge `cost` credits unless the user has an active paid tier (then it's free /
 * "unlimited"). Always records a Transaction so usage analytics stay intact.
 * Mirrors the atomic, balance-guarded deduction used across the controllers.
 * @returns {Promise<{ charged, skipped, insufficient, remainingCredits }>}
 */
const chargeOrSkip = async (user, cost, txMeta = {}) => {
  const type = txMeta.type || "usage";
  const description = txMeta.description || "AI usage";

  if (isPaidActive(user)) {
    await Transaction.create({
      userId: user._id,
      amount: 0,
      type,
      description: `${description} (covered by ${getEffectiveTier(user)} plan)`,
      status: "completed",
    });
    return { charged: false, skipped: true, insufficient: false, remainingCredits: user.credits };
  }

  const dec = await User.updateOne(
    { _id: user._id, credits: { $gte: cost } },
    { $inc: { credits: -cost } }
  );
  if (dec.modifiedCount === 0) {
    return { charged: false, skipped: false, insufficient: true, remainingCredits: user.credits };
  }
  user.credits -= cost;
  await Transaction.create({
    userId: user._id,
    amount: -cost,
    type,
    description,
    status: "completed",
  });
  return { charged: true, skipped: false, insufficient: false, remainingCredits: user.credits };
};

module.exports = {
  getEffectiveTier,
  isPaidActive,
  modelForUser,
  grantEntitlement,
  chargeOrSkip,
  downloadStatus,
  consumeDownload,
  refundDownload,
};
