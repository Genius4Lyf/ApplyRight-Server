const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const {
  tailorStart,
  buildStart,
  briefPreview,
  draftJd,
  scan,
  recompute,
  rewriteRole,
  projectIdeas,
  sessions,
  updateTargetJob,
} = require("../controllers/studio.controller");

const { protect } = require("../middleware/auth.middleware");

// AI-specific limiter, scoped to the two routes that actually call a model
// (brief-preview, draft-jd, scan, rewrite-role). Mirrors app.js's aiLimiter (20 req/hour/IP) — build-start,
// tailor-start, sessions and recompute are document CRUD/free reads and must not
// share this budget with a user's own AI calls elsewhere in the app.
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "AI request limit reached for this hour. Please try again later.",
  },
});

// Aria Studio — the current user's sessions for the rail. A LEAN projection: a
// session IS a DraftCV, so this returns only the few fields the list renders.
router.get("/sessions", protect, sessions);

// Aria Studio — read a job WITHOUT creating anything, so the user can confirm (or
// correct) Aria's read before a tailored copy exists. Free, like /coach/brief: the
// extraction cache makes a re-preview of the same JD cost nothing.
router.post("/brief-preview", protect, aiLimiter, briefPreview);

// A persistent Studio CV can add or replace its JD at any point. The endpoint refreshes
// the Role Brief and invalidates every JD-derived cache as one coordinated operation.
router.post("/target-job", protect, aiLimiter, updateTargetJob);

// Aria Studio — draft a realistic, generic job posting from just a job title, for a
// user who has no real posting to paste. Charges DRAFT_JD, only after a non-empty
// draft comes back.
router.post("/draft-jd", protect, aiLimiter, draftJd);

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
router.post("/scan", protect, aiLimiter, scan);

// Aria Studio — free deterministic re-score after an edit. No AI, no charge.
router.post("/recompute", protect, recompute);

// Aria Studio — rewrite ONE role's existing bullets against the target job, returned
// before/after for per-bullet accept. Behind aiLimiter because it calls a model.
// Charges REWRITE_ROLE (tier-aware) only when the rewrite actually changed something.
router.post("/rewrite-role", protect, aiLimiter, rewriteRole);

// Aria Studio — propose AT MOST 3 project ideas grounded in the user's own CV, so a
// role that wants a project doesn't dead-end at a blank form. Behind aiLimiter because
// it calls a model. Charges PROJECT_IDEAS only when non-empty ideas come back; the
// FREE focused interview that follows a tap is where the value lands.
router.post("/project-ideas", protect, aiLimiter, projectIdeas);

module.exports = router;
