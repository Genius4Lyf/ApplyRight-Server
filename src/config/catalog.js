// Single source of truth for everything purchasable. The server ALWAYS reads the
// price/grant from here — never from the client — so a tampered checkout request
// can't buy a tier for the wrong amount or grant itself extra minutes.
//
// Marketing tiers map onto the existing User.tier enum (free/plus/pro) so the
// requireTier middleware and TIER_RANK keep working unchanged:
//   Weekly Pro / Monthly Pro -> "plus" (mini model)
//   Monthly Premium          -> "pro"  (full gpt-realtime model)
// The marketing label, minute allowance, model and period live here, decoupled
// from the coarse enum.

// Free tier's one-time live-interview taste (seconds). Lifetime, never resets.
const FREE_TASTE_SEC = 300; // 5 minutes

// Minimum interview length (seconds) before the AI scorecard ("review") is run.
// The grading call is the costly part of a session, so we only spend it once the
// candidate has done a substantial interview — this stops "End & review" from
// being tapped repeatedly on near-empty sessions to burn AI credits. Sessions
// shorter than this still have their minutes metered (reconciled), they just don't
// get the expensive score. Shared by the assess gate (server) + the UI gate.
const MIN_REVIEW_SEC = 8 * 60; // 8 minutes

// Per-tier hard cap on a single live interview's length (seconds). Paid users
// pick any length up to this cap (and up to their remaining balance) via the
// intro slider; free is fixed at its taste. REALTIME_MAX_SESSION_SEC remains the
// absolute backstop and is applied on top of these in maxSessionSecForTier.
const MAX_SESSION_SEC_BY_TIER = {
  // 10 min — lets a free-tier Practice Pass holder spend their full 10-min pass in
  // ONE session (the recommended length). The free TASTE itself is still bounded to
  // 5 min by the 300s taste balance (budgetCap = min(cap, balance)), so this only
  // unlocks the longer session once minutes have been purchased.
  free: 600,
  plus: 900, // 15 min — Weekly/Monthly Pro
  pro: 1200, // 20 min — Premium gets the longest sessions as a tier perk
};

// model: "mini" -> gpt-realtime-mini, "full" -> gpt-realtime (see subscription.service.modelForUser)
const CATALOG = {
  weekly_pro: {
    id: "weekly_pro",
    label: "Starter Pack",
    purpose: "subscription",
    amountNgn: 3500,
    amountUsd: 4,
    tier: "plus",
    model: "mini",
    minutes: 15,
    credits: 150, // text-AI/CV/prep allowance; resets each period (no roll-over)
    periodDays: 7,
  },
  monthly_pro: {
    id: "monthly_pro",
    label: "Level Up",
    purpose: "subscription",
    amountNgn: 9500,
    amountUsd: 12,
    tier: "plus",
    model: "mini",
    minutes: 50,
    credits: 500,
    periodDays: 30,
  },
  monthly_premium: {
    id: "monthly_premium",
    label: "Boss Tier",
    purpose: "subscription",
    amountNgn: 15000,
    amountUsd: 20,
    tier: "pro",
    model: "full",
    minutes: 45,
    credits: 1000,
    periodDays: 30,
  },
  // CV Agent plans — for people who create CVs for clients. Each grants a pool of
  // CV credits (for tailoring) + UNLIMITED downloads (isPaidActive skips the ₦500
  // download charge), and NO live interview minutes (minutes: 0). Map to "plus" so
  // they count as paid. weekly / monthly / yearly cycles. Drives the agent role +
  // earnings dashboard (/agent).
  agent_weekly: {
    id: "agent_weekly",
    label: "Small Wins",
    purpose: "subscription",
    amountNgn: 3500,
    amountUsd: 5,
    tier: "plus",
    model: "mini", // unused — 0 interview minutes
    minutes: 0,
    credits: 250, // reseller CV allowance (no interview minutes)
    periodDays: 7,
  },
  agent_monthly: {
    id: "agent_monthly",
    label: "Big Taker",
    purpose: "subscription",
    amountNgn: 10000,
    amountUsd: 14,
    tier: "plus",
    model: "mini",
    minutes: 0,
    credits: 1200,
    periodDays: 30,
  },
  agent_yearly: {
    id: "agent_yearly",
    label: "Odogwu",
    purpose: "subscription",
    amountNgn: 100000,
    amountUsd: 140,
    tier: "plus",
    model: "mini",
    minutes: 0,
    credits: 18000,
    periodDays: 365,
  },
  // Credit top-up packs — bought when the credit balance runs low. Added to the
  // PERSISTENT wallet (never reset), unlike the per-tier allowance.
  credits_500: {
    id: "credits_500",
    label: "75 Credits",
    purpose: "credit",
    amountNgn: 500,
    amountUsd: 0.75,
    credits: 75,
  },
  credits_1000: {
    id: "credits_1000",
    label: "150 Credits",
    purpose: "credit",
    amountNgn: 1000,
    amountUsd: 1.5,
    credits: 150,
  },
  // Practice Pass — the cheap, one-off entry above the free taste. A free-tier
  // user buys this to run ONE full 10-min scored mock interview (the recommended
  // session length; solo + mini model, like the free taste, but WITH the full AI
  // scorecard — the scorecard is the value). purpose "topup" → grantEntitlement
  // adds the minutes to liveInterview balance, tier stays free. The minute economy
  // is tier-independent, so the buyer can actually spend these (createRealtimeSession
  // draws purchased minutes first) and the scorecard unlocks because the session is
  // paid-minutes, not free-taste. ~₦450 cost → ~55% margin. Repurchasable. Sits
  // below weekly_pro in the upgrade ladder.
  practice_pass: {
    id: "practice_pass",
    label: "Practice Pass",
    purpose: "topup",
    amountNgn: 1000,
    amountUsd: 1.5,
    minutes: 10,
  },
  topup_5: {
    id: "topup_5",
    label: "5 min top-up",
    purpose: "topup",
    amountNgn: 1000,
    amountUsd: 1.5,
    minutes: 5,
  },
  topup_15: {
    id: "topup_15",
    label: "15 min top-up",
    purpose: "topup",
    amountNgn: 2500,
    amountUsd: 3.5,
    minutes: 15,
  },
  // One-time clean CV download (after the free first download). Priced for the
  // reseller case: a CV agent charges their client ~₦1,000 and keeps ₦500.
  download_single: {
    id: "download_single",
    label: "CV Download",
    purpose: "download",
    amountNgn: 500,
    amountUsd: 0.75,
    downloads: 1,
  },
};

// Estimated all-in OpenAI cost per live minute, in NGN, for the admin
// margin guardrail (audio in/out + transcription + the post-session grading
// call). Calibrated from a real measurement: a 10-min `mini` session = $0.29
// all-in ≈ ₦450 → ~₦45/min, rounded up to ₦50 for FX/talky-user buffer. `full`
// measured ~₦52/min earlier; held at ₦80 for safety. Tune from the OpenAI
// usage dashboard. Keyed by the catalog model field.
const EST_COST_NGN_PER_MIN = {
  mini: 50,
  full: 80,
};

const getItem = (planId) => CATALOG[planId] || null;

module.exports = {
  CATALOG,
  FREE_TASTE_SEC,
  MIN_REVIEW_SEC,
  MAX_SESSION_SEC_BY_TIER,
  EST_COST_NGN_PER_MIN,
  getItem,
};
