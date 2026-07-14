const express = require("express");
const router = express.Router();
const docxController = require("../controllers/docx.controller");
const { protect } = require("../middleware/auth.middleware");

// POST /api/docx/generate
router.post("/generate", protect, docxController.generateCvDocx);

module.exports = router;
