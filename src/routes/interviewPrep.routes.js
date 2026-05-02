const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const interviewPrepController = require("../controllers/interviewPrep.controller");

router.post("/save-skills", protect, interviewPrepController.saveSkills);
router.get("/", protect, interviewPrepController.list);
router.get("/:applicationId", protect, interviewPrepController.getOne);
router.patch("/:applicationId/notes", protect, interviewPrepController.updateNotes);
router.delete("/:applicationId", protect, interviewPrepController.remove);

module.exports = router;
