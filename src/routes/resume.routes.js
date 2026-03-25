const express = require("express");
const router = express.Router();
const multer = require("multer");
const { uploadResume, uploadAndCreateDraft, getResumes } = require("../controllers/resume.controller");
const { protect } = require("../middleware/auth.middleware");

// Multer setup — 5MB limit enforced server-side
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post("/upload", protect, upload.single("resume"), uploadResume);
router.post("/upload-and-create", protect, upload.single("resume"), uploadAndCreateDraft);
router.get("/", protect, getResumes);

module.exports = router;
