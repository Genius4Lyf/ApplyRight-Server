// Single source of truth for Transaction.type values.
//
// WHY THIS FILE EXISTS: the allowed types used to live only as an inline enum
// array inside models/Transaction.js. Adding a new AI action meant remembering
// to edit a schema in a different folder, and forgetting was invisible until
// runtime — a ValidationError thrown from Transaction.create AFTER the credits
// had already been deducted (see spendCredits in subscription.service.js).
// That cost real users real credits. Referencing TRANSACTION_TYPES from the
// charge sites turns a typo into an import-time/lint error instead.
//
// Grouped by what the entry means in the ledger. `amount` is negative for
// spends and positive for grants; the type only says WHY it moved.
const TRANSACTION_TYPES = Object.freeze({
  // --- Credits in ---
  PURCHASE: "purchase",
  AD_REWARD: "ad_reward",
  STREAK_BONUS: "streak_bonus",
  DAILY_LOGIN: "daily_login",
  REFERRAL_BONUS: "referral_bonus",

  // --- Credits out: generic ---
  // Catch-all spend. Prefer a specific type below for anything new so the
  // admin analytics can break it out; "usage" is effectively unattributable.
  USAGE: "usage",

  // --- Credits out: CV tailoring ---
  CV_TAILOR: "cv_tailor",
  TAILOR_BUNDLE: "tailor_bundle",

  // --- Credits out: Aria / Studio AI actions ---
  GENERATE_BULLET: "generate_bullet",
  GENERATE_SUMMARY: "generate_summary",
  GENERATE_SKILLS: "generate_skills",
  ARIA_CHAT: "aria_chat",
  DRAFT_JD: "draft_jd",
  STUDIO_SCAN: "studio_scan",
});

// The array form Mongoose's `enum` validator wants.
const TRANSACTION_TYPE_VALUES = Object.freeze(Object.values(TRANSACTION_TYPES));

const TRANSACTION_STATUSES = Object.freeze({
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
});

const TRANSACTION_STATUS_VALUES = Object.freeze(Object.values(TRANSACTION_STATUSES));

const isValidTransactionType = (type) => TRANSACTION_TYPE_VALUES.includes(type);

module.exports = {
  TRANSACTION_TYPES,
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_VALUES,
  isValidTransactionType,
};
