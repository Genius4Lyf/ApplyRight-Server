const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const { submitFeedback } = require("../controllers/aiFeedback.controller");

router.post("/", protect, submitFeedback);

module.exports = router;
