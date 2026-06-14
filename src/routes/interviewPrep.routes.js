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

// Adaptive interviewer: one dynamic follow-up question (1 credit).
router.post(
  "/:applicationId/follow-up",
  protect,
  interviewPrepController.generateFollowUp
);

// Conversational Interview Mode: one live turn-based exchange. FREE during
// testing; later add requireTier("plus") + a credit charge in the controller.
router.post(
  "/:applicationId/conversation-turn",
  protect,
  interviewPrepController.conversationTurn
);

// Realtime voice interview: mint a short-lived OpenAI ephemeral client secret;
// the browser does the WebRTC handshake directly with OpenAI. FREE during
// testing; later add requireTier("plus") + a credit charge in the controller.
router.post(
  "/:applicationId/realtime-session",
  protect,
  interviewPrepController.createRealtimeSession
);

// Assess a finished conversational interview from its transcript (AI grade,
// grounded in CV + job). Persists as the prep's last session. FREE during testing.
router.post(
  "/:applicationId/assess-interview",
  protect,
  interviewPrepController.assessInterview
);

router.post(
  "/:applicationId/interview-session",
  protect,
  interviewPrepController.saveInterviewSession
);

router.delete("/:applicationId", protect, interviewPrepController.remove);

module.exports = router;
