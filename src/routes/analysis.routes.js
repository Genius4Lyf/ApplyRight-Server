const express = require("express");
const router = express.Router();
const {
  analyzeFit,
  generateApplicationCV,
  generateApplicationCoverLetter,
  generateApplicationInterview,
  editApplication,
} = require("../controllers/analysis.controller");
const { protect } = require("../middleware/auth.middleware");

// Core analysis (10 credits with job, 15 credits upload-only)
router.post("/analyze", protect, analyzeFit);

// On-demand asset generation (requires existing application)
router.post("/:id/generate-cv", protect, generateApplicationCV);
router.post("/:id/generate-cover-letter", protect, generateApplicationCoverLetter);
router.post("/:id/generate-interview", protect, generateApplicationInterview);

// Edit: create DraftCV from application's optimized CV
router.post("/:id/edit", protect, editApplication);

module.exports = router;
