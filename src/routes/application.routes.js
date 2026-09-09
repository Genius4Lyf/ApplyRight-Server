const express = require("express");
const router = express.Router();
const {
  getApplications,
  getApplicationById,
  updatePresentation,
  updateStatus,
  deleteApplication,
} = require("../controllers/application.controller");
const { protect } = require("../middleware/auth.middleware");

router.get("/", protect, getApplications);
router.get("/:id", protect, getApplicationById);
// Both names, one handler. /template predates the design half and is kept so an older
// deployed frontend does not 404 on a template change during a split deploy.
router.patch("/:id/presentation", protect, updatePresentation);
router.patch("/:id/template", protect, updatePresentation);
router.patch("/:id/status", protect, updateStatus);
router.delete("/:id", protect, deleteApplication);

module.exports = router;
