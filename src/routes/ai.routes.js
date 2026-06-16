const express = require("express");
const router = express.Router();
const { generateApplication } = require("../controllers/ai.controller");
const { protect } = require("../middleware/auth.middleware");

router.post("/generate", protect, generateApplication);
const {
  generateBullets,
  generateSkills,
  getJobKeywords,
  getKeywordCoverage,
} = require("../controllers/ai.controller");
router.post("/generate-bullets", protect, generateBullets);
router.post("/generate-skills", protect, generateSkills);
router.post("/job-keywords", protect, getJobKeywords);
router.post("/keyword-coverage", protect, getKeywordCoverage);

module.exports = router;
