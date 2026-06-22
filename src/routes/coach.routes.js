const express = require("express");
const router = express.Router();
const { deepScan, guide } = require("../controllers/coach.controller");
const { protect } = require("../middleware/auth.middleware");

// CV Builder ATS Coach. The free, live "CV Health" score is computed client-side
// (no endpoint). This is the paid "Deep Scan": Job Match + Career Match +
// recruiter red-flags. Free users get one lifetime taste; gated in the controller.
// Mounted under the AI rate limiter in app.js since it triggers AI calls.
router.post("/deep-scan", protect, deepScan);

// Live conversational AI coach for the current builder step (free daily quota,
// paid unlimited; gated in the controller).
router.post("/guide", protect, guide);

module.exports = router;
