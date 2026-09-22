// Aria model selection — the small server-side spine that decides WHICH model powers a
// chat/tailoring request, GATES it (never trusting the client), and prices the action by
// the model's tier. Sits between the controllers and settings.service / ai.service.
//
// Locked decisions this enforces:
//  · Three tiers — light (default), advanced, flagship. No Opus-class models.
//  · Every tier spendable with ANY credits (ad-earned included).
//  · ONLY LIGHT is included in a paid plan. Advanced and flagship always meter credits —
//    their (higher) tier cost is charged even on a paid plan (paid simply draws its
//    allowance first, via spendCredits). Light on a paid plan draws the allowance too;
//    the "unlimited" feel is the included allowance, not a skip.
const { DEFAULT_MODEL, MODEL_TIERS, alwaysMeters } = require("../config/catalog");
const settingsService = require("./settings.service");
const subscription = require("./subscription.service");

// Resolve the effective model id for a request: an explicit per-call/session choice wins,
// else the draft's stored session model, else the user's saved default, else DEFAULT_MODEL.
const resolveModelId = ({ sessionModelId, draft, user } = {}) =>
  sessionModelId || draft?.studioModelId || user?.aiModelId || DEFAULT_MODEL;

// Gate a model id against the admin-resolved registry: it must EXIST and be `exposed`.
// Returns { ok, modelId, tier, row }. Callers reject an un-exposed/unknown model (400)
// rather than silently substituting — the client never dictates which model runs.
const gateModel = async (modelId) => {
  const models = await settingsService.getModels();
  const row = models[modelId];
  if (!row || row.exposed !== true) {
    return { ok: false, modelId, tier: "light", row: null };
  }
  // Validated against the tier LIST rather than compared to one name. It used to read
  // `row.tier === "flagship" ? "flagship" : "light"`, which quietly collapsed every other
  // value to light — so a third tier would have been added to the catalog, shown in the
  // picker, and then billed as the free one everywhere. An unrecognised tier still falls
  // to light, which is the safe direction: it can under-charge, where the other way bills
  // for something nobody chose.
  const tier = MODEL_TIERS.includes(row.tier) ? row.tier : "light";
  return { ok: true, modelId, tier, row };
};

// The credit cost for (action, tier). Light = today's costs; flagship = the tuned map.
// Never undefined — the flagship table inherits light costs for unlisted actions.
const costForAction = async (action, tier) => {
  const costs = await settingsService.getCreditCostsForTier(tier);
  return costs[action] ?? 0;
};

// One-shot resolve+gate+price for a charge site: pick the model, gate it (fall back to
// DEFAULT_MODEL if the requested one isn't exposed — never hard-fail a chat over a stale
// pick), then price the action by the resolved tier. Returns { modelId, tier, cost, gated }.
const resolveForAction = async ({ action, sessionModelId, draft, user }) => {
  const requested = resolveModelId({ sessionModelId, draft, user });
  let gate = await gateModel(requested);
  if (!gate.ok) gate = await gateModel(DEFAULT_MODEL); // stale/hidden pick → safe default
  const modelId = gate.ok ? gate.modelId : DEFAULT_MODEL;
  const tier = gate.ok ? gate.tier : "light";
  const cost = await costForAction(action, tier);
  return { modelId, tier, cost };
};

// Charge for a model-tier action, enforcing the locked billing rule:
//   ADVANCED + FLAGSHIP → ALWAYS meter (spendCredits) — even on a paid plan (paid draws
//              its allowance first, but it is never free — no unlimited-Sonnet blow-out,
//              and no unlimited reasoning model either).
//   LIGHT    → FREE on an active paid plan (the "unlimited text AI on paid" perk applies
//              to light models only); metered from credits for free-tier users.
// Returns the same shape as subscription.spendCredits: { charged, skipped, insufficient,
// remainingCredits }. A zero cost skips regardless (spendCredits already short-circuits).
const chargeForModel = async (user, cost, tier, txMeta = {}) => {
  if (alwaysMeters(tier)) {
    return subscription.spendCredits(user, cost, txMeta);
  }
  // LIGHT: unlimited on an active paid plan.
  if (subscription.isPaidActive(user)) {
    return {
      charged: false,
      skipped: true,
      insufficient: false,
      remainingCredits: subscription.availableCredits(user),
    };
  }
  return subscription.spendCredits(user, cost, txMeta);
};

module.exports = {
  resolveModelId,
  gateModel,
  costForAction,
  resolveForAction,
  chargeForModel,
  // Re-exported from the catalog so every charge site can ask the billing question
  // ("does this tier always meter?") through the service it already imports, rather than
  // spelling it as a comparison against one tier name — which is how a third tier came to
  // be free on paid plans in fourteen places at once.
  alwaysMeters,
  DEFAULT_MODEL,
};
