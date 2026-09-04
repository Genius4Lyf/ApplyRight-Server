// Server-authoritative CV-template pricing. The client must NEVER set the unlock
// price — it sends only a templateId and the server decides the cost. The full
// template catalog (names, thumbnails, descriptions) lives in the frontend
// (applyright-frontend/src/data/templates.js); here we only need to know which
// ids are free and what a premium unlock costs.
//
// Anything NOT in FREE_TEMPLATE_IDS is treated as premium and costs
// TEMPLATE_UNLOCK_COST credits to unlock (paid tiers unlock all for free). Keep
// FREE_TEMPLATE_IDS in sync with the `isPro: false` entries in the frontend list.
const FREE_TEMPLATE_IDS = ["ats-clean", "student-ats"];

// Uniform premium unlock price (every isPro template costs the same today).
const TEMPLATE_UNLOCK_COST = 30;

const isFreeTemplate = (templateId) => FREE_TEMPLATE_IDS.includes(templateId);

// Is the "everything free" promo running right now?
//
// Takes the settings object rather than fetching, so it stays a pure function that
// the callers already holding settings can use — and so a test can move time without
// touching the database.
const isTemplatePromoActive = (settings) => {
  const until = settings?.templates?.freeUntil;
  if (!until) return false;
  const at = new Date(until).getTime();
  // An unparseable date must not read as "free forever".
  return Number.isFinite(at) && at > Date.now();
};

module.exports = {
  FREE_TEMPLATE_IDS,
  TEMPLATE_UNLOCK_COST,
  isFreeTemplate,
  isTemplatePromoActive,
};
