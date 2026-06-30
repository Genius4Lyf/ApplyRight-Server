const express = require("express");
const router = express.Router();
const { deepScan, guide, rewriteRole, recheck } = require("../controllers/coach.controller");
const { protect } = require("../middleware/auth.middleware");

// CV Builder ATS Coach. The free, live "CV Health" score is computed client-side
// (no endpoint). This is the paid "Deep Scan": Job Match + Career Match +
// recruiter red-flags. Free users get one lifetime taste; gated in the controller.
// Mounted under the AI rate limiter in app.js since it triggers AI calls.
router.post("/deep-scan", protect, deepScan);

// Live conversational AI coach for the current builder step (free daily quota,
// paid unlimited; gated in the controller).
router.post("/guide", protect, guide);

// Turn a red-flag into a fix: generate role-targeted ATS bullet rewrites for one
// work-history role or project (paid; gated in the controller).
router.post("/rewrite-role", protect, rewriteRole);

// Re-verify after applying fixes — recompute red-flags + fit score so resolved
// items flip green (paid, repeatable; gated in the controller).
router.post("/recheck", protect, recheck);

module.exports = router;
