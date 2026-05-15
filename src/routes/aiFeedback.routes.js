const express = require("express");
const router = express.Router();
const { protect, admin } = require("../middleware/auth.middleware");
const { submitFeedback, stats, list } = require("../controllers/aiFeedback.controller");

// User-facing — submit a 👍/👎 on an AI artifact.
router.post("/", protect, submitFeedback);

// Admin-only — aggregated stats + paginated list of recent feedback.
router.get("/stats", protect, admin, stats);
router.get("/", protect, admin, list);

module.exports = router;
