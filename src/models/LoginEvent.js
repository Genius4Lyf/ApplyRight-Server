const mongoose = require("mongoose");

/**
 * One row per successful login. Powers active-user analytics (DAU/WAU/MAU and the
 * active-users-over-time chart) that a single `User.lastLoginAt` can't give —
 * we need the full time-series of distinct users per day.
 *
 * Auto-expires after 180 days via TTL index to keep the collection bounded;
 * rolled-up daily metrics could be persisted separately later if longer history
 * is needed. `role` is stored so analytics can exclude admin logins.
 */
const loginEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  role: { type: String, default: "user" },
  // Indexed via the TTL index below (which also serves range queries) — no
  // separate `index: true` here, to avoid a duplicate-index warning.
  createdAt: { type: Date, default: Date.now },
});

// 180-day TTL — long enough for MAU trends, short enough to stay bounded.
loginEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

module.exports = mongoose.model("LoginEvent", loginEventSchema);
