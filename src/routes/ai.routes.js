const express = require("express");
const router = express.Router();
const { generateApplication } = require("../controllers/ai.controller");
const { protect } = require("../middleware/auth.middleware");

router.post("/generate", protect, generateApplication);
const {
  generateBullets,
  revealAtsTaste,
  generateSummaries,
  generateSkills,
  getJobKeywords,
  getKeywordCoverage,
  tightenSummary,
} = require("../controllers/ai.controller");
router.post("/generate-bullets", protect, generateBullets);
router.post("/reveal-ats-taste", protect, revealAtsTaste);
router.post("/generate-summaries", protect, generateSummaries);
router.post("/generate-skills", protect, generateSkills);
router.post("/job-keywords", protect, getJobKeywords);
router.post("/keyword-coverage", protect, getKeywordCoverage);
router.post("/tighten-summary", protect, tightenSummary);

module.exports = router;
