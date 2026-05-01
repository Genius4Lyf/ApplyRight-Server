const mongoose = require("mongoose");

/**
 * Cache for deterministic AI extractions (extractCandidateData, extractJobRequirements).
 *
 * These calls run at temperature 0.1 — effectively deterministic — so the
 * same input text reliably produces the same output. Caching by sha256(input)
 * cuts the regenerate-CV path from 2 LLM calls to 0 on cache hit, which is
 * the dominant cost in repeated CV generation against the same resume + JD.
 *
 * Auto-expires after 30 days. Hits don't extend the TTL — once the model
 * version or prompt changes, stale entries should fall out naturally.
 */
const extractionCacheSchema = new mongoose.Schema(
  {
    operation: { type: String, required: true }, // e.g. "extractCandidateData"
    contentHash: { type: String, required: true }, // sha256 of input
    model: { type: String, required: true }, // model that produced this output
    result: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

// Compound uniqueness: one cached result per (operation, hash, model). Keying
// includes the model so a model upgrade naturally invalidates entries instead
// of serving stale outputs from the old model.
extractionCacheSchema.index(
  { operation: 1, contentHash: 1, model: 1 },
  { unique: true }
);

// 30-day TTL on createdAt
extractionCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model("ExtractionCache", extractionCacheSchema);
