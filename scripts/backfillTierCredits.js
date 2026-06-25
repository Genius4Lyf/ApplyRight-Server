/**
 * One-off backfill: grant existing ACTIVE subscribers their per-tier credit
 * allowance (subscription.creditsRemaining), since the field defaults to 0 and
 * the old model never set it. Idempotent-ish: only fills subscribers whose
 * creditsRemaining is missing/0 so re-running won't wipe partially-spent balances.
 *
 * Run once after deploying the credit-allocation change:
 *   node scripts/backfillTierCredits.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/User");
const { getItem } = require("../src/config/catalog");

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set — aborting.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected. Backfilling tier credits for active subscribers…");

  const now = new Date();
  // Active subscribers: a real subscription that hasn't expired.
  const users = await User.find({
    "subscription.planId": { $ne: null },
    "subscription.expiresAt": { $gt: now },
  }).select("_id email subscription.planId subscription.creditsRemaining");

  let granted = 0;
  let skipped = 0;
  for (const u of users) {
    const item = getItem(u.subscription?.planId);
    const allowance = item?.credits || 0;
    const current = u.subscription?.creditsRemaining || 0;
    // Only fill empty/missing balances — never reduce a balance someone is using.
    if (allowance > 0 && current === 0) {
      await User.updateOne(
        { _id: u._id },
        { $set: { "subscription.creditsRemaining": allowance } }
      );
      granted += 1;
      console.log(`  +${allowance} → ${u.email} (${u.subscription.planId})`);
    } else {
      skipped += 1;
    }
  }

  console.log(`\nDone. Granted: ${granted}, skipped (already had credits / 0-credit plan): ${skipped}.`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
