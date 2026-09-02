const mongoose = require("mongoose");

const systemSettingsSchema = new mongoose.Schema(
  {
    // Grants & rewards only (NOT per-action costs — those live in
    // config/creditCosts.js and are overridden via `creditCosts` below).
    credits: {
      signupBonus: { type: Number, default: 20 },
      referralBonus: { type: Number, default: 10 },
      adRewardAndroid: { type: Number, default: 10 },
    },
    // Admin-editable overrides for per-action credit costs. Keys are the
    // canonical names in config/creditCosts.js (e.g. ANALYSIS, GENERATE_CV).
    // Starts EMPTY: the resolver (settings.getCreditCosts) falls back to the real
    // defaults, so a fresh deploy with no admin edits changes nothing. Only keys
    // an admin actually changes are stored here.
    creditCosts: {
      type: Map,
      of: Number,
      default: {},
    },
    // FLAGSHIP-tier per-action credit-cost overrides. Same empty-default Map pattern as
    // `creditCosts` (the LIGHT tier). Keys are the canonical action names; the resolver
    // (settings.getCreditCostsForTier('flagship')) layers these over the light costs +
    // the DEFAULT_FLAGSHIP_CREDIT_COSTS deltas, so an unset action inherits the light cost.
    flagshipCreditCosts: {
      type: Map,
      of: Number,
      default: {},
    },
    // Admin-editable overrides for the AI model registry (config/catalog.js DEFAULT_MODELS).
    // Keys are model ids; each value is a partial row ({ tier, exposed, inUsdPer1M, ... })
    // merged over the default row — so an admin can flip a model's `exposed`, retune a
    // price, or add a model without a deploy. Starts EMPTY (pure defaults). Mixed, because
    // rows are objects (a Map of Number can't hold them).
    models: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // Optional daily FLAGSHIP allowance for paid plans (free flagship actions/day before
    // credits are charged). Default 0 = off — flagship always meters, per the locked
    // decision. Admin can raise it to grant a taste without an unlimited-Sonnet blow-out.
    flagshipDailyAllowance: {
      type: Number,
      default: 0,
    },
    features: {
      maintenanceMode: { type: Boolean, default: false },
      enablePdfGeneration: { type: Boolean, default: true },
      enableAiAnalysis: { type: Boolean, default: true },
      enableJobSearch: { type: Boolean, default: true },
      admobEnabled: { type: Boolean, default: false },
    },
    // Pre-launch campaign. Deliberately SEPARATE from features.maintenanceMode: the
    // plain "Under Maintenance" page has to stay available for a genuine unplanned
    // outage, where a launch countdown would be a lie. Both on = pre-launch page;
    // maintenance alone = the old maintenance page, unchanged.
    launch: {
      enabled: { type: Boolean, default: false },
      // Countdown target. Null = no timer rendered (the page falls back to plain copy
      // rather than counting down to NaN).
      date: { type: Date, default: null },
      // What a signup receives while the campaign runs, INSTEAD of credits.signupBonus.
      bonusCredits: { type: Number, default: 50 },
    },
    announcement: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: "" },
      type: { type: String, enum: ["info", "warning", "critical"], default: "info" },
    },
    templates: {
      featuredTemplateId: { type: String, default: "ats-clean" },
      disabledTemplateIds: [{ type: String }],
    },
    // Interview Mode AI-interviewer voice. The provider toggle is admin-switchable;
    // the API keys live in env (secrets). "off" disables premium voice so the
    // frontend falls back to the browser's built-in TTS.
    tts: {
      provider: {
        type: String,
        enum: ["elevenlabs", "openai", "off"],
        default: "elevenlabs",
      },
    },
  },
  {
    timestamps: true,
  }
);

// Enforce singleton pattern: only one doc should exist
systemSettingsSchema.statics.getInstance = async function () {
  const settings = await this.findOne();
  if (settings) return settings;
  return await this.create({});
};

module.exports = mongoose.model("SystemSettings", systemSettingsSchema);
