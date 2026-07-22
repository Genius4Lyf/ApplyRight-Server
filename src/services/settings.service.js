const SystemSettings = require("../models/SystemSettings");
const {
  DEFAULT_CREDIT_COSTS,
  DEFAULT_FLAGSHIP_CREDIT_COSTS,
} = require("../config/creditCosts");
const { DEFAULT_MODELS } = require("../config/catalog");

// Merge a Mongoose Map (or a plain object, for test mocks) onto a base object. Spreading a
// Mongoose Map directly DROPS every entry, so convert first. Shared by every resolver here.
const mergeOverride = (base, overrideMap) => {
  let overrides = {};
  if (overrideMap) {
    overrides = overrideMap instanceof Map ? Object.fromEntries(overrideMap) : overrideMap;
  }
  return { ...base, ...overrides };
};

// Short-lived in-process cache for the resolved credit-cost map so we don't hit
// the DB on every credit charge. NOTE: this is a SINGLE-INSTANCE assumption — if
// the backend is ever scaled to multiple processes/instances, each holds its own
// cache and an admin edit is only guaranteed to propagate after the TTL. Keep the
// TTL short so a price change goes live quickly everywhere.
const CREDIT_COSTS_TTL_MS = 30 * 1000;
let creditCostsCache = null;
let creditCostsCachedAt = 0;
// Parallel short caches for the flagship-tier costs and the model registry — same TTL,
// same single-instance caveat, invalidated together on any settings write.
let flagshipCostsCache = null;
let flagshipCostsCachedAt = 0;
let modelsCache = null;
let modelsCachedAt = 0;

const invalidateCreditCostsCache = () => {
  creditCostsCache = null;
  creditCostsCachedAt = 0;
  flagshipCostsCache = null;
  flagshipCostsCachedAt = 0;
  modelsCache = null;
  modelsCachedAt = 0;
};

const SettingsService = {
  // Get the singleton settings object
  getSettings: async () => {
    return await SystemSettings.getInstance();
  },

  // Update settings (partial updates allowed)
  updateSettings: async (updates) => {
    const settings = await SystemSettings.getInstance();

    // Deep merge logic (simplified for Mongoose)
    // We iterate over the keys to update
    Object.keys(updates).forEach((key) => {
      if (
        typeof updates[key] === "object" &&
        updates[key] !== null &&
        !Array.isArray(updates[key])
      ) {
        // Mongoose Map fields (e.g. creditCosts) can't be merged with
        // Object.assign — that sets JS props on the Map object, not map entries.
        // The admin UI sends the FULL current override set, so replace wholesale
        // (assigning a plain object to a Map path coerces + replaces; {} clears
        // all overrides, restoring pure defaults).
        if (settings[key] instanceof Map) {
          settings[key] = updates[key];
          settings.markModified(key);
        } else {
          // Nested object update (e.g. credits.signupBonus)
          if (!settings[key]) settings[key] = {};
          Object.assign(settings[key], updates[key]);
        }
      } else {
        // Direct value update or array
        settings[key] = updates[key];
      }
    });

    await settings.save();
    // Any settings write may have changed the credit-cost overrides — drop the
    // cache so the next charge resolves fresh.
    invalidateCreditCostsCache();
    return settings;
  },

  // Get a specific value (helper)
  get: async (path) => {
    const settings = await SystemSettings.getInstance();
    const keys = path.split(".");
    let value = settings;
    for (const key of keys) {
      value = value ? value[key] : undefined;
    }
    return value;
  },

  // Resolve the effective per-action credit costs: real defaults with any
  // admin overrides merged on top. With no overrides (fresh deploy), this equals
  // DEFAULT_CREDIT_COSTS exactly — behavior-neutral. Cached for a short window.
  getCreditCosts: async () => {
    const now = Date.now();
    if (creditCostsCache && now - creditCostsCachedAt < CREDIT_COSTS_TTL_MS) {
      return creditCostsCache;
    }
    const settings = await SystemSettings.getInstance();
    creditCostsCache = mergeOverride(DEFAULT_CREDIT_COSTS, settings && settings.creditCosts);
    creditCostsCachedAt = now;
    return creditCostsCache;
  },

  // Resolve the per-action credit costs for a MODEL TIER ('light' | 'flagship'). Light is
  // exactly getCreditCosts() (today's costs). Flagship layers the flagship deltas +
  // admin flagship overrides ON TOP of the resolved light costs — so an action with no
  // flagship entry inherits its light cost, and the resolver never returns undefined.
  getCreditCostsForTier: async (tier) => {
    const light = await SettingsService.getCreditCosts();
    if (tier !== "flagship") return light;
    const nowTs = Date.now();
    if (flagshipCostsCache && nowTs - flagshipCostsCachedAt < CREDIT_COSTS_TTL_MS) {
      return flagshipCostsCache;
    }
    const settings = await SystemSettings.getInstance();
    // light costs → flagship default deltas → admin flagship overrides (each wins over the
    // prior), so the flagship map is a complete cost table for every action.
    const withDeltas = { ...light, ...DEFAULT_FLAGSHIP_CREDIT_COSTS };
    flagshipCostsCache = mergeOverride(withDeltas, settings && settings.flagshipCreditCosts);
    flagshipCostsCachedAt = nowTs;
    return flagshipCostsCache;
  },

  // The resolved AI model registry: catalog defaults with any admin per-model overrides
  // (SystemSettings.models) merged on top. Each override is a PARTIAL row shallow-merged
  // onto its default row, so flipping one field (e.g. exposed) keeps the rest intact.
  getModels: async () => {
    const now = Date.now();
    if (modelsCache && now - modelsCachedAt < CREDIT_COSTS_TTL_MS) {
      return modelsCache;
    }
    const settings = await SystemSettings.getInstance();
    let overrides = {};
    if (settings && settings.models) {
      overrides =
        settings.models instanceof Map ? Object.fromEntries(settings.models) : settings.models;
    }
    const resolved = {};
    // Start from the defaults, then per-model shallow-merge each override row.
    for (const [id, row] of Object.entries(DEFAULT_MODELS)) resolved[id] = { ...row };
    for (const [id, patch] of Object.entries(overrides || {})) {
      resolved[id] = { ...(resolved[id] || {}), ...(patch || {}) };
    }
    modelsCache = resolved;
    modelsCachedAt = now;
    return modelsCache;
  },

  // Exposed for tests and for controllers that mutate settings outside
  // updateSettings and need the next charge to see the change immediately.
  invalidateCreditCostsCache,
};

module.exports = SettingsService;
