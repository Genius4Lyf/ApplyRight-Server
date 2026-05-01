const express = require("express");
const router = express.Router();
const {
  getApplications,
  getApplicationById,
  updateTemplate,
  updateStatus,
  deleteApplication,
} = require("../controllers/application.controller");
const { protect } = require("../middleware/auth.middleware");

router.get("/", protect, getApplications);
router.get("/:id", protect, getApplicationById);
router.patch("/:id/template", protect, updateTemplate);
router.patch("/:id/status", protect, updateStatus);
router.delete("/:id", protect, deleteApplication);

module.exports = router;
