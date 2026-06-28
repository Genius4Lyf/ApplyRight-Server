// Entitlement engine — the single place that reasons about a user's paid status,
// grants entitlements after payment, and decides whether a credit charge applies.
// Reused by the webhook, the redirect fallback, the tier middleware, the live
// interview metering, and every text-AI charge site.
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const { getItem, MAX_SESSION_SEC_BY_TIER } = require("../config/catalog");

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

/**
 * Broad "entitled to paid perks right now" check for features gated on plan
 * rather than the minute economy (e.g. all CV templates unlocked). Honors
 * subscription expiry when a subscription exists; otherwise falls back to the
 * manually-set `plan` flag (admin grants set `plan: "paid"` with no subscription
 * subdoc). So an expired Flutterwave subscriber reverts to free, while an
 * admin-granted tester stays paid.
 */
const hasPaidAccess = (user) => {
  const exp = user?.subscription?.expiresAt;
  if (exp) return new Date(exp).getTime() > Date.now();
  return user?.plan === "paid";
};

/** Premium tier (pro) gets the sharper full model; everyone else the mini model. */
const modelForUser = (user) =>
  getEffectiveTier(user) === "pro" ? "gpt-realtime" : "gpt-realtime-mini";

/**
 * Text-AI (CV/content) model policy. CV agents are always paid (there are no free
 * CV agents — see cv.controller's NEED_AGENT_SUB gate) → always the stronger model.
 * Job seekers get the stronger model on ANY active paid tier (Plus or Pro); free
 * seekers get the standard model. ai.service maps this boolean to gpt-4o vs
 * gpt-4o-mini (respecting AI_MODEL / AI_MODEL_STRONG overrides).
 */
const usesStrongTextModel = (user) => user?.role === "agent" || isPaidActive(user);

/**
 * How the live interview panel is delivered for this user's tier:
 *  - "solo"         → single interviewer (free; today's behaviour)
 *  - "single-voice" → 3-person panel role-played in ONE session/voice with named
 *                     hand-offs (paid tiers)
 *  - "multi-voice"  → 3 distinct real voices via sequential segments (Premium only)
 * Both paid tiers (plus + pro) get the "single-voice" panel: ONE continuous
 * realtime session that role-plays all 3 interviewers. This is deliberate — a
 * single session shares the whole conversation, so the panel actually LISTENS to
 * the candidate's earlier answers, references them, paces itself (no per-person
 * stopwatch cuts) and has zero reconnect breaks. The tiles on screen still show
 * who's speaking via the set_active_speaker tool. Distinct real voices require
 * separate sessions, which breaks that continuity, so we trade voice timbre for a
 * genuinely conversational panel. Premium still runs the sharper model
 * (modelForUser). Free stays solo. "multi-voice" code is retained but unused.
 */
const panelModeForUser = (user) => {
  const eff = getEffectiveTier(user);
  if (eff === "free") return "solo";
  return "single-voice"; // plus + pro
};

/**
 * Hard cap (seconds) on a single live interview for this user's effective tier,
 * clamped by the global REALTIME_MAX_SESSION_SEC backstop. The intro slider uses
 * this (further bounded by the user's remaining balance) to let paid users pick a
 * length; free stays fixed at its taste.
 */
const maxSessionSecForTier = (user) => {
  const eff = getEffectiveTier(user);
  const tierCap = MAX_SESSION_SEC_BY_TIER[eff] || MAX_SESSION_SEC_BY_TIER.free;
  // The per-tier caps are authoritative. REALTIME_MAX_SESSION_SEC is an OPTIONAL
  // absolute ceiling for cost control — only applied when an operator explicitly
  // sets it (its in-code default of 360 must not silently cap the higher tiers).
  const raw = process.env.REALTIME_MAX_SESSION_SEC;
  const backstop = raw != null && raw !== "" ? Number(raw) : null;
  return backstop && backstop > 0 ? Math.min(tierCap, backstop) : tierCap;
};

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
          // No rollover: a new subscription REPLACES the per-tier credit allowance.
          // The persistent `credits` wallet (ad/referral/top-up) is untouched.
          "subscription.creditsRemaining": item.credits || 0,
        },
      }
    );
  } else if (item.purpose === "download") {
    // Download pass: add clean-download credits, nothing else.
    await User.updateOne(
      { _id: payment.userId },
      { $inc: { "downloads.passRemaining": item.downloads || 0 } }
    );
  } else if (item.purpose === "credit") {
    // Credit top-up: add to the PERSISTENT wallet (never reset). Money already
    // recorded in Payment; log a positive Transaction so it shows as bought credits.
    await User.updateOne(
      { _id: payment.userId },
      { $inc: { credits: item.credits || 0 } }
    );
    await Transaction.create({
      userId: payment.userId,
      amount: item.credits || 0,
      type: "purchase",
      description: `Bought ${item.credits || 0} credits (${item.label || item.id})`,
      status: "completed",
    });
  } else {
    // Minute top-up: add minutes only, leave tier/expiry untouched.
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
  // Free downloads removed — web users pay ₦500/CV (single pass) or subscribe.
  return {
    unlimited,
    passRemaining,
    freeAvailable: false,
    canDownload: unlimited || passRemaining > 0,
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

  // No more free downloads — a purchased ₦500 pass is the only non-subscription path.
  const pass = await User.updateOne(
    { _id: user._id, "downloads.passRemaining": { $gte: 1 } },
    { $inc: { "downloads.passRemaining": -1 } }
  );
  if (pass.modifiedCount === 1) return { ok: true, method: "pass" };

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
 * Total credits a user can spend right now = the active-tier allowance (the
 * resettable bucket; 0 once expired) + the persistent wallet. This is the number
 * every credit gate checks and the UI should show.
 */
const tierCreditsActive = (user) =>
  isPaidActive(user) ? Math.max(0, user?.subscription?.creditsRemaining || 0) : 0;

const availableCredits = (user) => tierCreditsActive(user) + Math.max(0, user?.credits || 0);

/**
 * Atomically spend `cost` credits, drawing from the per-tier allowance FIRST
 * (use-it-or-lose-it, since it resets) then the persistent wallet. Records ONE
 * Transaction for the total. Returns insufficient (no charge) when the combined
 * balance can't cover the cost. Mutates the in-memory `user` to match the DB.
 * @returns {Promise<{ charged, skipped, insufficient, remainingCredits }>}
 */
const spendCredits = async (user, cost, txMeta = {}) => {
  const type = txMeta.type || "usage";
  const description = txMeta.description || "AI usage";

  if (!cost || cost <= 0) {
    return { charged: false, skipped: true, insufficient: false, remainingCredits: availableCredits(user) };
  }
  if (availableCredits(user) < cost) {
    return { charged: false, skipped: false, insufficient: true, remainingCredits: availableCredits(user) };
  }

  const fromTier = Math.min(cost, tierCreditsActive(user));
  const fromWallet = cost - fromTier;

  // Build a guarded atomic update. Only touch the tier bucket when we're actually
  // drawing from it (a missing field wouldn't satisfy a $gte:0 guard for free users).
  const filter = { _id: user._id, credits: { $gte: fromWallet } };
  const inc = { credits: -fromWallet };
  if (fromTier > 0) {
    filter["subscription.creditsRemaining"] = { $gte: fromTier };
    inc["subscription.creditsRemaining"] = -fromTier;
  }
  const dec = await User.updateOne(filter, { $inc: inc });
  if (dec.modifiedCount === 0) {
    // Lost a race or balance shifted — treat as insufficient, no charge.
    return { charged: false, skipped: false, insufficient: true, remainingCredits: availableCredits(user) };
  }

  if (fromTier > 0 && user.subscription) {
    user.subscription.creditsRemaining = (user.subscription.creditsRemaining || 0) - fromTier;
  }
  user.credits = (user.credits || 0) - fromWallet;

  await Transaction.create({
    userId: user._id,
    amount: -cost,
    type,
    description: fromTier > 0 ? `${description} (${fromTier} plan + ${fromWallet} wallet)` : description,
    status: "completed",
  });
  return { charged: true, skipped: false, insufficient: false, remainingCredits: availableCredits(user) };
};

/**
 * Back-compat wrapper. Previously skipped the charge for paid tiers ("unlimited");
 * now EVERYONE spends credits — paid users simply draw from their tier allowance
 * first (see spendCredits). Kept as the name used across the charge sites.
 */
const chargeOrSkip = (user, cost, txMeta = {}) => spendCredits(user, cost, txMeta);

module.exports = {
  getEffectiveTier,
  isPaidActive,
  hasPaidAccess,
  modelForUser,
  usesStrongTextModel,
  panelModeForUser,
  maxSessionSecForTier,
  grantEntitlement,
  availableCredits,
  spendCredits,
  chargeOrSkip,
  downloadStatus,
  consumeDownload,
  refundDownload,
};
