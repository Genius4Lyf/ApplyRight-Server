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
    features: {
      maintenanceMode: { type: Boolean, default: false },
      enablePdfGeneration: { type: Boolean, default: true },
      enableAiAnalysis: { type: Boolean, default: true },
      enableJobSearch: { type: Boolean, default: true },
      admobEnabled: { type: Boolean, default: false },
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
