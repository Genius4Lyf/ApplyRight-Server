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

// model: "mini" -> gpt-realtime-mini, "full" -> gpt-realtime (see subscription.service.modelForUser)
const CATALOG = {
  weekly_pro: {
    id: "weekly_pro",
    label: "Weekly Pro",
    purpose: "subscription",
    amountNgn: 3000,
    amountUsd: 4,
    tier: "plus",
    model: "mini",
    minutes: 15,
    periodDays: 7,
  },
  monthly_pro: {
    id: "monthly_pro",
    label: "Monthly Pro",
    purpose: "subscription",
    amountNgn: 9000,
    amountUsd: 12,
    tier: "plus",
    model: "mini",
    minutes: 50,
    periodDays: 30,
  },
  monthly_premium: {
    id: "monthly_premium",
    label: "Monthly Premium",
    purpose: "subscription",
    amountNgn: 15000,
    amountUsd: 20,
    tier: "pro",
    model: "full",
    minutes: 45,
    periodDays: 30,
  },
  // CV Agent plans — for people who create CVs for clients. Unlimited CV tailoring
  // + unlimited downloads (isPaidActive), NO live interview minutes (minutes: 0).
  // Map to "plus" so they count as paid. weekly / monthly / yearly cycles.
  // (The dedicated agent role + CV-only dashboard are a future build — see
  // CV-AGENT-PLAN.md.)
  agent_weekly: {
    id: "agent_weekly",
    label: "CV Agent (Weekly)",
    purpose: "subscription",
    amountNgn: 3500,
    amountUsd: 5,
    tier: "plus",
    model: "mini", // unused — 0 interview minutes
    minutes: 0,
    periodDays: 7,
  },
  agent_monthly: {
    id: "agent_monthly",
    label: "CV Agent (Monthly)",
    purpose: "subscription",
    amountNgn: 10000,
    amountUsd: 14,
    tier: "plus",
    model: "mini",
    minutes: 0,
    periodDays: 30,
  },
  agent_yearly: {
    id: "agent_yearly",
    label: "CV Agent (Yearly)",
    purpose: "subscription",
    amountNgn: 100000,
    amountUsd: 140,
    tier: "plus",
    model: "mini",
    minutes: 0,
    periodDays: 365,
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
// margin guardrail (audio in/out + transcription, caching ON). Tune from the
// real OpenAI usage dashboard. Keyed by the catalog model field.
const EST_COST_NGN_PER_MIN = {
  mini: 100,
  full: 180,
};

const getItem = (planId) => CATALOG[planId] || null;

module.exports = { CATALOG, FREE_TASTE_SEC, EST_COST_NGN_PER_MIN, getItem };
