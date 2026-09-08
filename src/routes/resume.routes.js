const express = require("express");
const router = express.Router();
const {
  uploadResume,
  uploadAndCreateDraft,
  getResumes,
} = require("../controllers/resume.controller");
const { protect } = require("../middleware/auth.middleware");

// Upload handling — 5MB cap, type filter and multer's own error responses all live in
// one middleware, shared with the Studio's import route so the two cannot drift.
const { resumeUpload } = require("../middleware/resumeUpload.middleware");

router.post("/upload", protect, resumeUpload, uploadResume);
router.post("/upload-and-create", protect, resumeUpload, uploadAndCreateDraft);
router.get("/", protect, getResumes);

module.exports = router;
