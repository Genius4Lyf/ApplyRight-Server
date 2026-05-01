const express = require("express");
const router = express.Router();
const {
  analyzeFit,
  generateApplicationCV,
  generateApplicationCoverLetter,
  generateApplicationInterview,
  generateApplicationBundle,
  preflightMetrics,
  editApplication,
} = require("../controllers/analysis.controller");
const { protect } = require("../middleware/auth.middleware");

// Core analysis (10 credits with job, 15 credits upload-only)
router.post("/analyze", protect, analyzeFit);

// Pre-flight: detect vague bullets the user could quantify before CV generation.
// Free (no charge, cached extractions) — does NOT trigger generation by itself.
router.post("/:id/preflight-metrics", protect, preflightMetrics);

// On-demand asset generation (requires existing application)
router.post("/:id/generate-cv", protect, generateApplicationCV);
router.post("/:id/generate-cover-letter", protect, generateApplicationCoverLetter);
router.post("/:id/generate-interview", protect, generateApplicationInterview);
// Bundle: CV + cover letter + interview prep at a discount (18 vs 20 credits)
router.post("/:id/generate-bundle", protect, generateApplicationBundle);

// Edit: create DraftCV from application's optimized CV
router.post("/:id/edit", protect, editApplication);

module.exports = router;
