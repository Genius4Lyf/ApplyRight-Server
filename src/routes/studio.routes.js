const express = require("express");
const router = express.Router();
const {
  tailorStart,
  buildStart,
  briefPreview,
  scan,
  recompute,
  sessions,
} = require("../controllers/studio.controller");
const { protect } = require("../middleware/auth.middleware");

// Aria Studio — the current user's sessions for the rail. A LEAN projection: a
// session IS a DraftCV, so this returns only the few fields the list renders.
router.get("/sessions", protect, sessions);

// Aria Studio — read a job WITHOUT creating anything, so the user can confirm (or
// correct) Aria's read before a tailored copy exists. Free, like /coach/brief: the
// extraction cache makes a re-preview of the same JD cost nothing.
router.post("/brief-preview", protect, briefPreview);

// Aria Studio — start a tailor run. Clones the source CV's content into a new draft
// bound to the target job and attaches its Role Brief (the confirmed one from
// brief-preview when supplied). No credit charge here; the tailoring scan (Phase 2)
// is what costs.
router.post("/tailor-start", protect, tailorStart);

// Aria Studio — start a BUILD session: an empty CV prefilled with the user's contact
// details, optionally aimed at a job. Same create gate as tailor-start.
router.post("/build-start", protect, buildStart);

// Aria Studio — full scan: AI fit analysis + deterministic per-section verdicts.
// Charges ANALYSIS, and only after the AI succeeds.
router.post("/scan", protect, scan);

// Aria Studio — free deterministic re-score after an edit. No AI, no charge.
router.post("/recompute", protect, recompute);

module.exports = router;
