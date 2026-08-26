const express = require("express");
const router = express.Router();
const { generateApplication } = require("../controllers/ai.controller");
const { protect } = require("../middleware/auth.middleware");

router.post("/generate", protect, generateApplication);
const {
  generateSkills,
  getJobKeywords,
  getKeywordCoverage,
  tightenSummary,
} = require("../controllers/ai.controller");
router.post("/generate-skills", protect, generateSkills);
router.post("/job-keywords", protect, getJobKeywords);
router.post("/keyword-coverage", protect, getKeywordCoverage);
router.post("/tighten-summary", protect, tightenSummary);

module.exports = router;
