/**
 * One-off backfill: give every DraftCV EDUCATION entry a stable `_sortId`.
 *
 * Why this exists: `education` was the only entry list on DraftCV that never declared
 * `_sortId` (experience and projects both did), so Mongoose strict mode silently stripped
 * the id the client assigns on every save. Education entries were therefore
 * un-addressable server-side — a pin self-healed away after a reload, and the Live
 * Preview keyed education rows on `undefined`. The schema now declares the field; this
 * script repairs the documents written before it did.
 *
 * IDEMPOTENT: an entry that already has a non-empty `_sortId` is left exactly as it is,
 * so re-running is a no-op. Ids match the format the client mints (crypto.randomUUID,
 * see frontend src/lib/sortId.js) so there is one id format everywhere.
 *
 * Run once after deploying the DraftCV.education._sortId change:
 *   node scripts/backfillEducationSortIds.js
 *
 * Pass --dry to report what WOULD change without writing anything:
 *   node scripts/backfillEducationSortIds.js --dry
 */
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const DraftCV = require("../src/models/DraftCV");

const DRY_RUN = process.argv.includes("--dry");

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI not set — aborting.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(
    `Connected. Backfilling education._sortId${DRY_RUN ? " (DRY RUN — no writes)" : ""}…`
  );

  // Only drafts that actually carry education entries. Streamed with a cursor so a large
  // collection never has to fit in memory; .lean() because we write with updateOne, not save().
  const cursor = DraftCV.find({ "education.0": { $exists: true } })
    .select("_id education")
    .lean()
    .cursor();

  let scannedDrafts = 0;
  let touchedDrafts = 0;
  let filledEntries = 0;
  let skippedEntries = 0;

  for (let draft = await cursor.next(); draft != null; draft = await cursor.next()) {
    scannedDrafts += 1;
    const entries = Array.isArray(draft.education) ? draft.education : [];

    // Positional $set per missing entry — narrow enough that it can't disturb a
    // concurrent edit to a SIBLING education entry, or to any other field on the draft.
    const patch = {};
    entries.forEach((entry, index) => {
      if (entry && typeof entry._sortId === "string" && entry._sortId.trim()) {
        skippedEntries += 1; // already addressable — never re-mint an id something may reference
        return;
      }
      patch[`education.${index}._sortId`] = crypto.randomUUID();
    });

    const missing = Object.keys(patch).length;
    if (!missing) continue;

    if (!DRY_RUN) await DraftCV.updateOne({ _id: draft._id }, { $set: patch });
    touchedDrafts += 1;
    filledEntries += missing;
    console.log(`  ${DRY_RUN ? "would fill" : "filled"} ${missing} entr(ies) → draft ${draft._id}`);
  }

  console.log(
    `\nDone. Drafts scanned: ${scannedDrafts}, drafts ${DRY_RUN ? "to update" : "updated"}: ${touchedDrafts}, ` +
      `entries ${DRY_RUN ? "to fill" : "filled"}: ${filledEntries}, entries skipped (already had an id): ${skippedEntries}.`
  );
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
