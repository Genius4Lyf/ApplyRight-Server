const AICallLog = require("../models/AICallLog");
const Application = require("../models/Application");
const mongoose = require("mongoose");

const ALLOWED_FEEDBACK = ["up", "down"];

/**
 * Submit user feedback on an AI-generated artifact. The frontend identifies
 * the artifact by (applicationId, operation) — we resolve to the most recent
 * matching log entry and stamp the feedback there.
 *
 * One feedback per (application, operation): subsequent submissions overwrite
 * the previous on the latest log row. This keeps the data simple — we want
 * "is this user happy with the latest output?" not a full feedback history.
 */
exports.submitFeedback = async (req, res) => {
  try {
    const { applicationId, operation, feedback, comment } = req.body;

    if (!ALLOWED_FEEDBACK.includes(feedback)) {
      return res.status(400).json({
        message: "Invalid feedback value",
        allowed: ALLOWED_FEEDBACK,
      });
    }
    if (!applicationId || !operation) {
      return res.status(400).json({ message: "applicationId and operation are required" });
    }

    // Verify the user owns the application before letting them rate its logs.
    const app = await Application.findById(applicationId).select("userId");
    if (!app) return res.status(404).json({ message: "Application not found" });
    if (app.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    const log = await AICallLog.findOne({
      applicationId,
      operation,
    }).sort({ createdAt: -1 });

    if (!log) {
      // No log to attach to — happens if logs were TTL'd or AI failed before
      // logging. Don't error: tell the client we accepted the feedback but
      // had nothing to attach it to.
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
