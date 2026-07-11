const SystemSettings = require("../models/SystemSettings");
const { DEFAULT_CREDIT_COSTS } = require("../config/creditCosts");

// Short-lived in-process cache for the resolved credit-cost map so we don't hit
// the DB on every credit charge. NOTE: this is a SINGLE-INSTANCE assumption — if
// the backend is ever scaled to multiple processes/instances, each holds its own
// cache and an admin edit is only guaranteed to propagate after the TTL. Keep the
// TTL short so a price change goes live quickly everywhere.
const CREDIT_COSTS_TTL_MS = 30 * 1000;
let creditCostsCache = null;
let creditCostsCachedAt = 0;

const invalidateCreditCostsCache = () => {
  creditCostsCache = null;
  creditCostsCachedAt = 0;
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
    // settings.creditCosts is a Mongoose Map — spreading it directly would DROP
    // every entry, so convert to a plain object before merging. Guard for a
    // missing doc / already-plain-object (test mocks) so we always fall back to
    // the real defaults rather than throwing.
    let overrides = {};
    if (settings && settings.creditCosts) {
      overrides =
        settings.creditCosts instanceof Map
          ? Object.fromEntries(settings.creditCosts)
          : settings.creditCosts;
    }
    creditCostsCache = { ...DEFAULT_CREDIT_COSTS, ...overrides };
    creditCostsCachedAt = now;
    return creditCostsCache;
  },

  // Exposed for tests and for controllers that mutate settings outside
  // updateSettings and need the next charge to see the change immediately.
  invalidateCreditCostsCache,
};

module.exports = SettingsService;
