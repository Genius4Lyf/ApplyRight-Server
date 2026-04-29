const mongoose = require("mongoose");

/**
 * Audit log of every AI call. Used for:
 *   - Debugging bad outputs ("why did extraction return empty?")
 *   - Quality feedback loop (user 👍/👎 attaches to a log entry)
 *   - Cost / latency / error-rate dashboards
 *
 * Auto-expires after 90 days via TTL index. Prompts and responses are
 * truncated at MAX_FIELD_LEN to keep documents bounded; for full content
 * forensic debugging we'd add S3 archival later.
 */
const aiCallLogSchema = new mongoose.Schema(
  {
    operation: { type: String, required: true, index: true }, // e.g. "extractJobRequirements"
    provider: { type: String, enum: ["openai", "gemini"], required: true },
    model: { type: String },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Application", index: true },

    // Truncated prompt+response. Useful for spot-checking; not full-fidelity audit.
    systemPrompt: { type: String },
    userPrompt: { type: String },
    response: { type: String },

    tokensInput: { type: Number },
    tokensOutput: { type: Number },
    latencyMs: { type: Number },

    // Captured when the call throws so we can debug failure modes.
    errorMessage: { type: String },
    errorCode: { type: String },

    // User feedback on the artifact this call produced. Set later via the
    // feedback endpoint; null means "no rating yet".
    feedback: { type: String, enum: ["up", "down", null], default: null },
    feedbackComment: { type: String },
    feedbackAt: { type: Date },
  },
  { timestamps: true }
);

// 90-day TTL — keeps the table bounded; long enough to debug quality issues
// reported a month or two after the fact.
aiCallLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

// Compound index for the feedback endpoint: "find latest log for this
// application's most recent <operation>".
aiCallLogSchema.index({ applicationId: 1, operation: 1, createdAt: -1 });

module.exports = mongoose.model("AICallLog", aiCallLogSchema);
