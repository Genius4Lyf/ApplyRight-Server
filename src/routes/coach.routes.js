const express = require("express");
const router = express.Router();
const {
  guide,
  generateBullets,
  summary,
  setCompanyType,
  setModel,
  getBrief,
  setNoTarget,
  askAria,
  chat,
} = require("../controllers/coach.controller");
const { protect } = require("../middleware/auth.middleware");

// Live conversational AI coach for the current builder step (free daily quota,
// paid unlimited; gated in the controller).
router.post("/guide", protect, guide);

// Aria "build-with" bullet generation — turn a described role/project into N
// Role-Brief-grounded bullets. Charges count × GENERATE_BULLET; first re-roll of
// an identical request is free (gated in the controller).
router.post("/generate-bullets", protect, generateBullets);

// Aria career-stage-aware, JD-tailored professional summary. Charges GENERATE_SUMMARY
// per generation (each re-roll charges again; paid tiers draw from allowance).
router.post("/summary", protect, summary);

// Confirm/correct the inferred company type on Aria's Role Brief (infer+confirm
// chip). Persists the choice so a same-JD brief rebuild keeps it.
router.post("/company-type", protect, setCompanyType);

// Set the Aria model for this session (draft.studioModelId) and optionally the user's
// default. Server-gated: the model must be `exposed`. Powers the model picker.
router.post("/model", protect, setModel);

// Fetch (or build+cache) Aria's Role Brief — powers the "Aria's read" strip.
// Cheap on repeat (same-JD cache hit); no target JD → { brief: null }.
router.post("/brief", protect, getBrief);

// Record "no target job — build a strong all-rounder", and cache the role-family
// vocabulary that stands in for a brief. Free (extraction-cached inference).
router.post("/no-target", protect, setNoTarget);

// Aria's free-form coach chat — warm, guardrailed Q&A on the cheap base model.
// Draws from the shared daily chat allowance, then ARIA_CHAT_MESSAGE credits each.
router.post("/ask", protect, askAria);

// Aria's UNIFIED chat — ONE focus-aware front door. Intent-classified + smart
// per-message charging: focused build-with is FREE, a general question spends the
// daily allowance. History/Projects use this; other steps still use /ask.
router.post("/chat", protect, chat);

module.exports = router;
