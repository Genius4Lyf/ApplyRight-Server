// Single source of truth for everything purchasable. The server ALWAYS reads the
// price/grant from here — never from the client — so a tampered checkout request
// can't buy a tier for the wrong amount or grant itself extra minutes.
//
// Marketing tiers map onto the existing User.tier enum (free/plus/pro) so the
// requireTier middleware and TIER_RANK keep working unchanged:
//   Starter Pack (2-week) / Monthly Pro -> "plus" (mini model)
//   Monthly Premium          -> "pro"  (full gpt-realtime-2.1 model)
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
  // 10 min, but inert: budgetCap = min(cap, balance) and a free user's only balance
  // is the 300s taste, so free sessions are bounded to 5 min by the balance, never
  // by this cap. Free users cannot buy minutes — top-ups are paid-only in the credit
  // store and the Practice Pass is retired — so the taste is the whole free offer.
  free: 600,
  plus: 1200, // 20 min — Starter Pack / Level Up
  pro: 1800, // 30 min — Boss Tier gets the longest sessions as a tier perk
};

// model: "mini" -> gpt-realtime-2.1-mini, "full" -> gpt-realtime-2.1 (see subscription.service.modelForUser)
const CATALOG = {
  weekly_pro: {
    id: "weekly_pro",
    label: "Starter Pack",
    purpose: "subscription",
    amountNgn: 3500,
    amountUsd: 4,
    tier: "plus",
    model: "mini",
    minutes: 20,
    credits: 150, // text-AI/CV/prep allowance; resets each period (no roll-over)
    periodDays: 14, // 2-week window (same price/allowances as the old 1-week plan)
  },
  monthly_pro: {
    id: "monthly_pro",
    label: "Level Up",
    purpose: "subscription",
    amountNgn: 9500,
    amountUsd: 12,
    tier: "plus",
    model: "mini",
    minutes: 60,
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
    // Boss Tier must beat Level Up on minutes — it previously granted fewer (45 vs
    // 50) at a higher price. At ₦80/min (full model) 90 min ≈ ₦7,200 of the ₦15,000,
    // the thinnest margin in the catalog before credits; watch it in admin revenue.
    minutes: 90,
    credits: 1000,
    periodDays: 30,
  },
  // CV Agent plans — for people who create CVs for clients. Each grants a pool of
  // CV credits (for tailoring) + UNLIMITED downloads (isPaidActive skips the ₦1,000
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
    amountNgn: 15000,
    amountUsd: 20,
    tier: "plus",
    model: "mini",
    minutes: 0,
    credits: 1500,
    periodDays: 30,
  },
  // RETIRED: a 365-day locked price on a cost base that moves (claude-sonnet-5 intro
  // pricing expires 2026-08-31) isn't safe to keep selling. Left in the catalog —
  // don't delete — because admin.controller.js resolves plan labels from here for
  // historical payment display, and existing subscribers' Payment records reference
  // this id. Rejected at checkout (billing.controller.js createCheckout); existing
  // holders are unaffected since these are one-time expiring purchases, no auto-renew.
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
    retired: true,
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
  // RETIRED: at ₦1,000 for 10 min (₦100/min) the Practice Pass undercut every other
  // top-up per minute — including the "best value" 5-hour pack at ₦113/min — and it
  // let a free user reach the scored interview without a plan. The free offer is now
  // exactly the 5-minute taste (practice only, no scorecard); anything beyond that is
  // a subscription. Left in the catalog — don't delete — because admin/billing resolve
  // labels from here for historical Payment records. Rejected at checkout.
  practice_pass: {
    id: "practice_pass",
    label: "Practice Pass",
    purpose: "topup",
    amountNgn: 1000,
    amountUsd: 1.5,
    minutes: 10,
    retired: true,
  },
  // RETIRED: the minute ladder now starts at 10 min because a real interview runs
  // 10/20/30 min — a 5-minute pack can't fund one, and 15 min sat awkwardly between
  // the 10 and 20 rungs. Kept for historical Payment label resolution.
  topup_5: {
    id: "topup_5",
    label: "5 min top-up",
    purpose: "topup",
    amountNgn: 1000,
    amountUsd: 1.5,
    minutes: 5,
    retired: true,
  },
  topup_15: {
    id: "topup_15",
    label: "15 min top-up",
    purpose: "topup",
    amountNgn: 2500,
    amountUsd: 3.5,
    minutes: 15,
    retired: true,
  },
  // Live ladder — mirrors the real interview lengths (10/20/30) then bulk packs.
  // Price per minute descends strictly down the ladder (₦180 → ₦160 → ₦150 → ₦133
  // → ₦125 → ₦113) so "best value" on the largest pack is literally true.
  topup_10: {
    id: "topup_10",
    label: "10 min top-up",
    purpose: "topup",
    amountNgn: 1800,
    amountUsd: 2.5,
    minutes: 10,
  },
  topup_20: {
    id: "topup_20",
    label: "20 min top-up",
    purpose: "topup",
    amountNgn: 3200,
    amountUsd: 4.5,
    minutes: 20,
  },
  topup_30: {
    id: "topup_30",
    label: "30 min top-up",
    purpose: "topup",
    amountNgn: 4500,
    amountUsd: 6,
    minutes: 30,
  },
  topup_60: {
    id: "topup_60",
    label: "1 hr top-up",
    purpose: "topup",
    amountNgn: 8000,
    amountUsd: 10,
    minutes: 60,
  },
  topup_120: {
    id: "topup_120",
    label: "2 hr top-up",
    purpose: "topup",
    amountNgn: 15000,
    amountUsd: 19,
    minutes: 120,
  },
  topup_300: {
    id: "topup_300",
    label: "5 hr top-up",
    purpose: "topup",
    amountNgn: 34000,
    amountUsd: 42,
    minutes: 300,
  },
  // One-time clean CV download (after the free first download). Priced at about
  // what a casual reseller charges their client for a CV — this deliberately
  // steers repeat resellers toward an agent subscription (unlimited downloads
  // from ₦3,500) instead of paying per-download.
  download_single: {
    id: "download_single",
    label: "CV Download",
    purpose: "download",
    amountNgn: 1000,
    amountUsd: 1.5,
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

// Estimated text-AI token prices (USD per 1M tokens), OpenAI list prices. Used
// by the admin "AI Spend" view to turn logged tokens (AICallLog) into an
// ESTIMATED NGN cost — NOT an invoice. Keyed by canonical model name.
const EST_TEXT_COST_USD_PER_MTOK = {
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10.0 },
};

// ── AI model registry (Aria's chat / tailoring model selection) ──
// modelId → { provider, apiModel, tier, inUsdPer1M, outUsdPer1M, exposed }. Two tiers
// ONLY: LIGHT (budget, the default) and FLAGSHIP (Sonnet-class ceiling — deliberately NO
// Opus and NO heavyweight reasoning models, to keep the cost floor predictable). Prices
// are USD list prices per 1M tokens and live HERE so a change is a one-line edit; the
// admin panel can override this whole map via SystemSettings.models (the same Map-override
// pattern as creditCosts). `exposed` gates whether a model is offered in the picker — the
// server enforces it, never the client.
//
// NOTE: claude-sonnet-5 intro pricing ($2 / $10 per 1M) ends 2026-08-31 → then $3 / $15.
// When that lands, edit the two numbers on the claude-sonnet-5 row below (or override via
// SystemSettings.models) — nothing else depends on the literal.
const DEFAULT_MODELS = Object.freeze({
  // LIGHT — cheap; the default tier. "Unlimited text AI on paid plans" applies to THESE.
  // Only gpt-4o-mini is EXPOSED (surfaced as "Standard"); the rest stay in the registry as
  // admin/cost options (exposed:false) so an admin can swap the Standard model without code.
  "deepseek-v4-flash": {
    provider: "deepseek",
    apiModel: "deepseek-chat",
    tier: "light",
    inUsdPer1M: 0.14,
    outUsdPer1M: 0.28,
    exposed: false,
  },
  "gpt-4o-mini": {
    provider: "openai",
    apiModel: "gpt-4o-mini",
    tier: "light",
    inUsdPer1M: 0.15,
    outUsdPer1M: 0.6,
    exposed: true,
  },
  "gpt-5-mini": {
    provider: "openai",
    apiModel: "gpt-5-mini",
    tier: "light",
    inUsdPer1M: 0.25,
    outUsdPer1M: 2.0,
    exposed: false,
  },
  "kimi-k2.5": {
    provider: "moonshot",
    apiModel: "kimi-k2.5",
    tier: "light",
    inUsdPer1M: 0.44,
    outUsdPer1M: 2.0,
    exposed: false,
  },
  // FLAGSHIP — Sonnet-class ceiling; ALWAYS meters credits, even on paid plans (an
  // unlimited Sonnet would be a cost blow-out). EXPOSED (surfaced as "Pro"): claude-sonnet-5
  // only. gpt-5, gpt-4o + gemini-3.5-flash stay in the registry as admin/cost options.
  "gpt-5": {
    provider: "openai",
    apiModel: "gpt-5.6-luna", // GPT-5.6 Luna — id unverified against this OpenAI account
    // (returns 502s live); parked as an admin/cost option, NOT offered, until confirmed.
    tier: "flagship",
    inUsdPer1M: 1.0,
    outUsdPer1M: 6.0,
    exposed: false,
  },
  "gemini-3.5-flash": {
    provider: "gemini",
    apiModel: "gemini-3.5-flash",
    tier: "flagship",
    inUsdPer1M: 1.5,
    outUsdPer1M: 9.0,
    exposed: false,
  },
  "claude-sonnet-5": {
    provider: "anthropic",
    apiModel: "claude-sonnet-5",
    tier: "flagship",
    inUsdPer1M: 2.0,
    outUsdPer1M: 10.0,
    exposed: true,
  },
  "gpt-4o": {
    provider: "openai",
    apiModel: "gpt-4o",
    tier: "flagship",
    inUsdPer1M: 2.5,
    outUsdPer1M: 10.0,
    exposed: false,
  },
});

// The out-of-the-box model. LIGHT, and its provider is OpenAI — the key that is already
// required for all text AI — so the default works with zero new keys, and the missing-key
// fallback (→ DEFAULT_MODEL's provider) is always satisfiable.
const DEFAULT_MODEL = "gpt-4o-mini";

// Valid tiers, in ascending cost. Exported so the cost resolver + gating share one list.
const MODEL_TIERS = ["light", "flagship"];

// Resolve a model row from a (possibly admin-overridden) models map, defaulting to the
// DEFAULT_MODEL row for an unknown id so callers always get a usable provider/apiModel.
const modelFrom = (models, id) =>
  (models && models[id]) || (models && models[DEFAULT_MODEL]) || DEFAULT_MODELS[DEFAULT_MODEL];

// The tier of a model id (light|flagship), defaulting to 'light' for an unknown id — the
// cheaper, safer assumption for cost/gating.
const tierOfModel = (models, id) => {
  const row = models && models[id];
  return row && MODEL_TIERS.includes(row.tier) ? row.tier : "light";
};

// FX used to convert the USD token estimate to NGN. Matches the rate implied by
// the per-minute live calibration above (~₦45/min mini at $0.29/10min ≈ 1550).
const NGN_PER_USD = 1550;

// Pick the token price row for a logged model name. "mini" models → mini
// pricing; any other gpt-4o* → full pricing; unknown → mini (cheapest, so an
// unlabelled call is never over-estimated).
const priceForModel = (model) => {
  const m = String(model || "").toLowerCase();
  if (m.includes("mini")) return EST_TEXT_COST_USD_PER_MTOK["gpt-4o-mini"];
  if (m.includes("gpt-4o")) return EST_TEXT_COST_USD_PER_MTOK["gpt-4o"];
  return EST_TEXT_COST_USD_PER_MTOK["gpt-4o-mini"];
};

const getItem = (planId) => CATALOG[planId] || null;

module.exports = {
  CATALOG,
  FREE_TASTE_SEC,
  MIN_REVIEW_SEC,
  MAX_SESSION_SEC_BY_TIER,
  EST_COST_NGN_PER_MIN,
  EST_TEXT_COST_USD_PER_MTOK,
  NGN_PER_USD,
  priceForModel,
  getItem,
  // Model registry (Aria chat/tailoring model selection)
  DEFAULT_MODELS,
  DEFAULT_MODEL,
  MODEL_TIERS,
  modelFrom,
  tierOfModel,
};
