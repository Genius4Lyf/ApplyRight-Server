const mongoose = require("mongoose");
const User = require("../models/User");
const DraftCV = require("../models/DraftCV");
const subscription = require("../services/subscription.service");
const aiService = require("../services/ai.service");
const { computeFitScore } = require("../services/scoringEngine.service");
const { cvDataToCandidate, detectRedFlags, coachState } = require("../services/atsCoach.service");

// Build the paid "Job Match" layer from the draft's target job description.
// Resilient: a missing JD or a transient AI failure returns { available:false }
// with a reason instead of throwing, so one weak layer can't sink the scan.
const buildJobMatch = async (draft, candidate, meta) => {
  const jd = (draft.targetJob?.description || "").trim();
  if (!jd) {
    return {
      available: false,
      reason: "no_jd",
      note: "Add a job description on the Target Job step to unlock Job Match.",
    };
  }
  // A bare job TITLE (e.g. "field operator") has nothing to extract, so the
  // fit score would collapse to its neutral ~50% defaults and mislead the user.
  // Require enough text to actually score against.
  if (jd.split(/\s+/).filter(Boolean).length < 12) {
    return {
      available: false,
      reason: "jd_too_short",
      note: "That looks like a job title, not a description. Paste the full posting (responsibilities + requirements) for an accurate match.",
    };
  }
  try {
    const jobData = await aiService.extractJobRequirements(jd, meta);
    jobData.jobDescription = jd;
    jobData.jobTitle = draft.targetJob?.title || jobData.detectedJobTitle || "";
    const score = computeFitScore({ candidateData: candidate, jobData });
    return { available: true, ...score };
  } catch (err) {
    console.error("Coach buildJobMatch error:", err.message);
    return {
      available: false,
      reason: "ai_error",
      note: "Couldn't analyse the job description right now. Please try again.",
    };
  }
};

// @desc    Run the CV Coach "Deep Scan" — Job Match + Career Match + recruiter
//          red-flags. Paid (active subscription) users run it freely; free users
//          get ONE lifetime taste, claimed atomically before any AI spend and
//          refunded if the scan yields nothing (mirrors revealAtsTaste).
// @route   POST /api/coach/deep-scan
// @access  Private (job-seekers only — not CV-agent client CVs)
const deepScan = async (req, res) => {
  const { draftId, jobDescription } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to scan this CV" });
    }

    // A JD pasted into the scan field is the single source of truth — persist it
    // to the draft's target job so the keyword panel and ATS bullet suggestions
    // use it too (the cached paid keyword extraction is invalidated since the JD
    // changed). Done before gating so even a locked free user's JD is saved.
    const overrideJd = (jobDescription || "").trim();
    if (overrideJd && overrideJd !== (draft.targetJob?.description || "").trim()) {
      if (!draft.targetJob) draft.targetJob = {};
      draft.targetJob.description = overrideJd;
      draft.targetJob.aiKeywords = [];
      draft.targetJob.aiKeywordsHash = undefined;
      await draft.save();
    }

    const user = await User.findById(req.user.id).select("plan subscription coach");
    const isPaid = subscription.isPaidActive(user); // honors subscription expiry
    const tasteAvailable = !user?.coach?.deepScanTasteUsed;

    // Nothing meaningful to scan yet — don't run the AI or spend the free taste on
    // an empty CV (which would otherwise score a misleading ~50% match against the
    // engine's neutral defaults). Built before the taste claim so it's never spent.
    const candidate = cvDataToCandidate(draft);
    const enoughCv =
      (candidate.experience?.length || 0) >= 1 ||
      (candidate.skills?.length || 0) >= 3 ||
      (candidate.projects?.length || 0) >= 1 ||
      (candidate.summary || "").trim().length >= 40;
    if (!enoughCv) {
      return res.json({ isPaid, tooEmpty: true, tasteAvailable });
    }

    // Free user who already spent their taste → blurred teaser only, no AI spend.
    if (!isPaid && !tasteAvailable) {
      return res.json({ isPaid: false, locked: true, tasteAvailable: false });
    }

    // Free user spending the one-time taste: claim it ATOMICALLY before spending
    // any tokens, so the real scan runs at most once per account, ever.
    if (!isPaid) {
      const claimed = await User.findOneAndUpdate(
        { _id: req.user.id, "coach.deepScanTasteUsed": { $ne: true } },
        { $set: { "coach.deepScanTasteUsed": true } }
      );
      if (!claimed) {
        // Lost a race — the taste was just used elsewhere.
        return res.json({ isPaid: false, locked: true, tasteAvailable: false });
      }
    }

    const meta = { userId: req.user.id, operation: "coachDeepScan" };

    try {
      const [jobMatch, careerMatch] = await Promise.all([
        buildJobMatch(draft, candidate, meta),
        aiService
          .recommendRoles(candidate, { jobDescription: draft.targetJob?.description || "" }, meta)
          .catch((err) => {
            console.error("Coach recommendRoles error:", err.message);
            return { roles: [] };
          }),
      ]);
      const redFlags = detectRedFlags(draft);

      // If the paid layers produced nothing useful, don't burn the free taste —
      // refund it so the user can retry (red-flags alone aren't worth the taste).
      const usefulRoles = (careerMatch.roles || []).length > 0;
      if (!isPaid && !jobMatch.available && !usefulRoles) {
        await User.updateOne({ _id: req.user.id }, { $set: { "coach.deepScanTasteUsed": false } });
        return res.status(502).json({
          message: "Couldn't generate your coach insights. Please try again.",
        });
      }

      return res.json({
        isPaid,
        taste: !isPaid, // this response spent the free taste
        tasteAvailable: false, // none left after this run
        jobMatch,
        careerMatch: careerMatch.roles || [],
        redFlags,
      });
    } catch (err) {
      // Hard failure mid-scan: refund the taste so the user isn't charged for nothing.
      if (!isPaid) {
        await User.updateOne({ _id: req.user.id }, { $set: { "coach.deepScanTasteUsed": false } });
      }
      throw err;
    }
  } catch (error) {
    if (error instanceof aiService.AIUnavailableError) {
      return res
        .status(503)
        .json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Coach Deep Scan Error:", error);
    return res.status(500).json({ message: "Failed to run ATS deep scan" });
  }
};

// @desc    Live conversational CV coach — a short, personal, gap-aware message
//          (and optional step-by-step guide) for the user's current step. Free
//          users get a daily quota; paid tiers are unlimited. Always degrades to
//          a client-side scripted fallback (never blank, never hard-blocks).
// @route   POST /api/coach/guide
// @access  Private (job-seekers only)
const guide = async (req, res) => {
  const { draftId, step, signal, cvData } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    let draft;
    if (draftId === "new") {
      draft = cvData || {};
    } else {
      if (!mongoose.Types.ObjectId.isValid(draftId)) {
        return res.status(400).json({ message: "Invalid draftId format" });
      }
      draft = await DraftCV.findById(draftId);
      if (!draft) {
        return res.status(404).json({ message: "CV not found" });
      }
      if (draft.userId.toString() !== req.user.id) {
        return res.status(403).json({ message: "Not authorized" });
      }
    }

    const user = await User.findById(req.user.id).select("plan subscription");
    // The conversational coach is a PAID feature, gated on the effective subscription
    // (subscription.isPaidActive — honors expiry, the canonical paid check used across
    // the backend). Free users get the deterministic CV Journey only — no AI coaching.
    if (!subscription.isPaidActive(user)) {
      return res.json({ locked: true });
    }

    // Prefer the live cvData the client sends (what the user has typed RIGHT NOW)
    // over the saved draft, which lags until a step transition. Falls back to the
    // draft when no live state is provided.
    const gaps = coachState(cvData && typeof cvData === "object" ? cvData : draft);
    let result;
    try {
      result = await aiService.coachMessage(
        {
          firstName: gaps.firstName,
          step: step || draft.currentStep || "",
          gaps,
          signal: (signal || "").toString().slice(0, 200),
        },
        { userId: req.user.id, operation: "coachGuide" }
      );
    } catch (err) {
      if (err instanceof aiService.AIUnavailableError) {
        return res.json({ fallback: true });
      }
      throw err;
    }

    return res.json({ ...result });
  } catch (error) {
    console.error("Coach Guide Error:", error);
    // Soft-fail to the client's scripted coach rather than erroring the UI.
    return res.json({ fallback: true });
  }
};

module.exports = { deepScan, guide };
