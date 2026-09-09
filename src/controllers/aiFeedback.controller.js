const AICallLog = require("../models/AICallLog");
const Application = require("../models/Application");
const mongoose = require("mongoose");

const ALLOWED_FEEDBACK = ["up", "down"];

/**
 * Submit user feedback on an AI-generated artifact. Two ways to say which artifact:
 *
 *   logId          — the exact call. The endpoint that produced the thing being rated
 *                    minted this id before making the call and returned it (see
 *                    persistLog in ai.service). This is the only way to rate ONE message
 *                    in a conversation, where "the latest call of this operation" would
 *                    file the rating against whichever answer happened to come last.
 *
 *   applicationId  — the original path, kept: rate the most recent <operation> run for
 *   + operation      an application. Right where an application HAS one current artifact
 *                    (a cover letter, an analysis) and rating means "this one".
 *
 * Either way the rating overwrites any previous one on that row. We want "is the user
 * happy with this output?", not a history of them changing their mind.
 */
exports.submitFeedback = async (req, res) => {
  try {
    const { applicationId, operation, feedback, comment, logId } = req.body;

    if (!ALLOWED_FEEDBACK.includes(feedback)) {
      return res.status(400).json({
        message: "Invalid feedback value",
        allowed: ALLOWED_FEEDBACK,
      });
    }
    if (!logId && (!applicationId || !operation)) {
      return res
        .status(400)
        .json({ message: "logId, or applicationId and operation, are required" });
    }

    let log;
    if (logId) {
      if (!mongoose.Types.ObjectId.isValid(logId)) {
        return res.status(400).json({ message: "Invalid logId" });
      }
      log = await AICallLog.findById(logId);
      // Ownership is on the log itself here — there is no application standing in front
      // of it — so this check IS the authorization, not a formality. Without it any
      // signed-in user could stamp feedback onto anyone's call by guessing an id.
      if (log && String(log.userId || "") !== req.user.id) {
        return res.status(401).json({ message: "User not authorized" });
      }
    } else {
      // Verify the user owns the application before letting them rate its logs.
      const app = await Application.findById(applicationId).select("userId");
      if (!app) return res.status(404).json({ message: "Application not found" });
      if (app.userId.toString() !== req.user.id) {
        return res.status(401).json({ message: "User not authorized" });
      }

      log = await AICallLog.findOne({
        applicationId,
        operation,
      }).sort({ createdAt: -1 });
    }

    if (!log) {
      // No log to attach to — the row was TTL'd, the AI failed before logging, or (for
      // logId) the audit write lost its race with a very fast rating. Don't error: the
      // user pressed a thumb and the UI must not tell them their opinion failed. We
      // accepted it; we just had nothing to hang it on.
      return res.json({ status: "noop", reason: "no matching log" });
    }

    log.feedback = feedback;
    log.feedbackComment = comment || undefined;
    log.feedbackAt = new Date();
    await log.save();

    res.json({
      status: "ok",
      logId: log._id,
      feedback: log.feedback,
    });
  } catch (error) {
    console.error("Submit feedback error:", error.message);
    res.status(500).json({ message: "Failed to submit feedback" });
  }
};

/**
 * Admin: aggregate counts of 👍/👎 by operation, plus a small recent-window
 * snapshot. Used by the AdminAIFeedback dashboard's KPI cards. Bounded by
 * the AICallLog 90-day TTL so totals naturally roll forward.
 */
exports.stats = async (req, res) => {
  try {
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [byOperation, last30] = await Promise.all([
      AICallLog.aggregate([
        { $match: { feedback: { $ne: null } } },
        {
          $group: {
            _id: "$operation",
            up: { $sum: { $cond: [{ $eq: ["$feedback", "up"] }, 1, 0] } },
            down: { $sum: { $cond: [{ $eq: ["$feedback", "down"] }, 1, 0] } },
            total: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
      ]),
      AICallLog.aggregate([
        { $match: { feedback: { $ne: null }, feedbackAt: { $gte: since30 } } },
        {
          $group: {
            _id: null,
            up: { $sum: { $cond: [{ $eq: ["$feedback", "up"] }, 1, 0] } },
            down: { $sum: { $cond: [{ $eq: ["$feedback", "down"] }, 1, 0] } },
            total: { $sum: 1 },
          },
        },
      ]),
    ]);

    res.json({
      byOperation,
      last30Days: last30[0] || { up: 0, down: 0, total: 0 },
    });
  } catch (error) {
    console.error("AI feedback stats error:", error.message);
    res.status(500).json({ message: "Failed to fetch feedback stats" });
  }
};

/**
 * Admin: recent feedback entries with light context. Paginated by ?page= +
 * filtered by ?feedback= (up|down) or ?operation= for triage.
 */
exports.list = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const filter = { feedback: { $ne: null } };
    if (req.query.feedback === "up" || req.query.feedback === "down") {
      filter.feedback = req.query.feedback;
    }
    if (req.query.operation) {
      filter.operation = req.query.operation;
    }

    const [items, total] = await Promise.all([
      AICallLog.find(filter)
        .sort({ feedbackAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(
          "operation feedback feedbackComment feedbackAt provider model latencyMs userId applicationId errorMessage createdAt"
        )
        .populate("userId", "email firstName lastName")
        .populate("applicationId", "jobTitle jobCompany")
        .lean(),
      AICallLog.countDocuments(filter),
    ]);

    res.json({
      items,
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (error) {
    console.error("AI feedback list error:", error.message);
    res.status(500).json({ message: "Failed to fetch feedback list" });
  }
};
