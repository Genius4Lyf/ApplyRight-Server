const express = require("express");
const router = express.Router();
const {
  analyzeFit,
  generateApplicationCV,
  generateApplicationCoverLetter,
  generateApplicationInterview,
  startDirectInterview,
  generateMoreApplicationInterview,
  generateApplicationStories,
  generateApplicationEssential,
  generateDressGuide,
  generateApplicationBundle,
  preflightMetrics,
  editApplication,
} = require("../controllers/analysis.controller");
const { protect, requireTier } = require("../middleware/auth.middleware");

// Core analysis (10 credits with job, 15 credits upload-only)
router.post("/analyze", protect, analyzeFit);

// Standalone "Interview Me": skip the full analysis and go straight to a live
// interview. Paid-only (requireTier 403s free users with TIER_REQUIRED); no
// per-action credit charge. Live minutes are still metered in realtime-session.
router.post("/direct-interview", protect, requireTier("plus"), startDirectInterview);

// Pre-flight: detect vague bullets the user could quantify before CV generation.
// Free (no charge, cached extractions) — does NOT trigger generation by itself.
router.post("/:id/preflight-metrics", protect, preflightMetrics);

// On-demand asset generation (requires existing application)
router.post("/:id/generate-cv", protect, generateApplicationCV);
router.post("/:id/generate-cover-letter", protect, generateApplicationCoverLetter);
router.post("/:id/generate-interview", protect, generateApplicationInterview);
// Append more questions (avoids duplicates of existing ones). Same 5-credit cost.
router.post("/:id/generate-more-interview", protect, generateMoreApplicationInterview);
// Story Bank: reusable STAR stories grounded in the candidate's history.
router.post("/:id/generate-stories", protect, generateApplicationStories);
// Essential answer: personalized "tell me about yourself" / "why this company".
router.post("/:id/generate-essential", protect, generateApplicationEssential);
// "What to wear" — tailored interview-attire & first-impression guide (2 credits).
router.post("/:id/generate-dress-guide", protect, generateDressGuide);
// Bundle: CV + cover letter + interview prep at a discount (18 vs 20 credits)
router.post("/:id/generate-bundle", protect, generateApplicationBundle);

// Edit: create DraftCV from application's optimized CV
router.post("/:id/edit", protect, editApplication);

module.exports = router;
