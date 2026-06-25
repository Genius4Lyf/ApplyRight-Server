const express = require("express");
const router = express.Router();
const { protect, agent } = require("../middleware/auth.middleware");
const { getSummary } = require("../controllers/agent.controller");

// All agent routes require an authenticated CV-agent account.
router.use(protect, agent);

router.get("/summary", getSummary);

module.exports = router;
