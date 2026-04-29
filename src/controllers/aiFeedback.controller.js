const AICallLog = require("../models/AICallLog");
const Application = require("../models/Application");

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
