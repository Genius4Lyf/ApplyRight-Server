const Application = require("../models/Application");

// @desc    Get user's applications
// @route   GET /api/applications
// @access  Private
const getApplications = async (req, res) => {
  try {
    const applications = await Application.find({ userId: req.user.id })
      .populate("jobId", "title company")
      .populate("resumeId", "createdAt")
      .sort({ createdAt: -1 });

    res.json(applications);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// @desc    Get a single application by id (used for polling generation progress)
// @route   GET /api/applications/:id
// @access  Private
const getApplicationById = async (req, res) => {
  try {
    // Populate resumeId.createdAt so the detail view can label which resume
    // (by upload date) drove this analysis — useful when a user has multiple
    // versions of their CV uploaded.
    const application = await Application.findById(req.params.id)
      .populate("jobId", "title company")
      .populate("resumeId", "createdAt");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }
    res.json(application);
  } catch (error) {
    console.error("Get application error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

const deleteApplication = async (req, res) => {
  try {
    const application = await Application.findById(req.params.id);

    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    // Check user
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    await application.deleteOne();

    res.json({ id: req.params.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

const updateTemplate = async (req, res) => {
  try {
    const { templateId } = req.body;
    const application = await Application.findById(req.params.id);

    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    // Check user
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    application.templateId = templateId;
    await application.save();

    res.json(application);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

// Allowed application statuses must match the enum in models/Application.js
const ALLOWED_STATUSES = [
  "analyzed",
  "assets_generated",
  "submitted",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
];

// @desc    Update an application's user-facing status
// @route   PATCH /api/applications/:id/status
// @access  Private
const updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({
        message: "Invalid status",
        allowed: ALLOWED_STATUSES,
      });
    }

    const application = await Application.findById(req.params.id);
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    application.status = status;
    application.statusUpdatedAt = new Date();
    await application.save();

    res.json({
      _id: application._id,
      status: application.status,
      statusUpdatedAt: application.statusUpdatedAt,
    });
  } catch (error) {
    console.error("Update status error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = {
  getApplications,
  getApplicationById,
  updateTemplate,
  updateStatus,
  deleteApplication,
};
