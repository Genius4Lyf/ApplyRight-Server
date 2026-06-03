const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const interviewPrepController = require("../controllers/interviewPrep.controller");

router.post("/save-skills", protect, interviewPrepController.saveSkills);
router.get("/", protect, interviewPrepController.list);
router.get("/:applicationId", protect, interviewPrepController.getOne);
router.get("/:applicationId/linked-cv", protect, interviewPrepController.getLinkedCV);

// Legacy single-string notes endpoint. Kept as a compat shim — the controller
// folds the incoming string into the first note in the new array shape.
router.patch("/:applicationId/notes", protect, interviewPrepController.updateNotes);

// Multi-note CRUD.
router.post("/:applicationId/notes", protect, interviewPrepController.createNote);
router.patch("/:applicationId/notes/:noteId", protect, interviewPrepController.updateNote);
router.delete("/:applicationId/notes/:noteId", protect, interviewPrepController.deleteNote);

router.patch(
  "/:applicationId/skill-confidence",
  protect,
  interviewPrepController.updateSkillConfidence
);

router.patch(
  "/:applicationId/question-confidence",
  protect,
  interviewPrepController.updateQuestionConfidence
);

router.post(
  "/:applicationId/grade-answer",
  protect,
  interviewPrepController.gradeAnswer
);

router.delete("/:applicationId", protect, interviewPrepController.remove);

module.exports = router;
