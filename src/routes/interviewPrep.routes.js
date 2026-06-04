const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const interviewPrepController = require("../controllers/interviewPrep.controller");

router.post("/save-skills", protect, interviewPrepController.saveSkills);
// Interview Mode: AI-interviewer voice (premium TTS). Generic — not per-prep.
router.post("/tts", protect, interviewPrepController.synthesizeTts);
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

// Story Bank: confidence + CRUD (manual add / edit-autosave / delete).
router.patch(
  "/:applicationId/story-confidence",
  protect,
  interviewPrepController.updateStoryConfidence
);
router.post("/:applicationId/stories", protect, interviewPrepController.createStory);
router.patch("/:applicationId/stories/:storyId", protect, interviewPrepController.updateStory);
router.delete("/:applicationId/stories/:storyId", protect, interviewPrepController.deleteStory);

router.post(
  "/:applicationId/grade-answer",
  protect,
  interviewPrepController.gradeAnswer
);

router.post(
  "/:applicationId/grade-story",
  protect,
  interviewPrepController.gradeStoryAnswer
);

router.post(
  "/:applicationId/interview-session",
  protect,
  interviewPrepController.saveInterviewSession
);

router.delete("/:applicationId", protect, interviewPrepController.remove);

module.exports = router;
