const Application = require("../models/Application");
const DraftCV = require("../models/DraftCV");

// Project shape that the list page renders. Picks just what the card needs so
// the response stays small.
const LIST_PROJECTION = {
  jobTitle: 1,
  jobCompany: 1,
  jobId: 1,
  status: 1,
  "interviewPrep.isSaved": 1,
  "interviewPrep.savedAt": 1,
  "interviewPrep.skillsWithEvidence": 1,
  "interviewPrep.jobQuestions": 1,
  "interviewPrep.questionsToAsk": 1,
  updatedAt: 1,
};

/**
 * Persist skill-based interview prep. Three modes:
 *   1. Caller passes `applicationId` + `skillsWithEvidence` array — used as-is.
 *   2. Caller passes only `applicationId` — controller pulls skill metadata
 *      from the linked DraftCV.
 *   3. Caller passes only `draftCVId` (no applicationId) — used by CV Builder
 *      Skills page. Controller finds all applications linked to that draft
 *      and saves the prep to each, then returns the most recently updated
 *      application's id for navigation.
 */
exports.saveSkills = async (req, res) => {
  try {
    const { applicationId, draftCVId, skillsWithEvidence } = req.body;
    if (!applicationId && !draftCVId) {
      return res.status(400).json({ message: "applicationId or draftCVId is required" });
    }

    // Mode 3 — save by draftCVId — fan out to all linked applications.
    if (!applicationId && draftCVId) {
      const draft = await DraftCV.findById(draftCVId).select("skills userId");
      if (!draft) return res.status(404).json({ message: "Draft CV not found" });
      if (draft.userId.toString() !== req.user.id) {
        return res.status(401).json({ message: "User not authorized" });
      }

      // Prefer caller-supplied skills (Skills.jsx may have unsaved changes
      // since the user generated them in this session). Fall back to the
      // persisted draft's skills.
      const sourceSkills = Array.isArray(skillsWithEvidence) && skillsWithEvidence.length
        ? skillsWithEvidence
        : draft.skills || [];

      const resolved = sourceSkills
        .filter((s) => Array.isArray(s.evidence) && s.evidence.length > 0)
        .map((s) => ({
          name: s.name,
          category: s.category,
          evidence: s.evidence,
          talkingPoint: s.talkingPoint || "",
        }));

      if (!resolved.length) {
        return res.status(400).json({
          message:
            "No skills with evidence found on this CV. Generate skills with the AI button first.",
        });
      }

      const apps = await Application.find({
        userId: req.user.id,
        draftCVId: draft._id,
      }).select("_id interviewPrep updatedAt");

      const now = new Date();

      // Always save the prep to the draft itself so it persists even before
      // any job analysis is run. Linked applications (if any) get the same
      // prep so it surfaces when the user opens that role's prep page.
      draft.interviewPrep = draft.interviewPrep || {};
      draft.interviewPrep.isSaved = true;
      draft.interviewPrep.savedAt = now;
      draft.interviewPrep.skillsWithEvidence = resolved;
      await draft.save();

      if (apps.length > 0) {
        await Promise.all(
          apps.map((app) => {
            app.interviewPrep = app.interviewPrep || {};
            app.interviewPrep.isSaved = true;
            app.interviewPrep.savedAt = now;
            app.interviewPrep.skillsWithEvidence = resolved;
            return app.save();
          })
        );

        // Return the most recently updated application so the frontend can
        // navigate the user there (richer view — job questions + skills).
        const sorted = [...apps].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        return res.json({
          status: "ok",
          savedAt: now,
          skillCount: resolved.length,
          applicationCount: apps.length,
          // Convention: clients use this `id` for navigation regardless of source.
          id: sorted[0]?._id,
          source: "application",
          applicationId: sorted[0]?._id,
        });
      }

      // CV-only path — no applications linked. Direct user to the draft-prep
      // detail view (skills section only, no job context).
      return res.json({
        status: "ok",
        savedAt: now,
        skillCount: resolved.length,
        applicationCount: 0,
        id: draft._id,
        source: "draft",
        draftCVId: draft._id,
      });
    }

    // Modes 1 & 2 — save by applicationId.
    const application = await Application.findById(applicationId).select(
      "userId interviewPrep draftCVId"
    );
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    let resolved = Array.isArray(skillsWithEvidence) ? skillsWithEvidence : null;
    if (!resolved) {
      if (!application.draftCVId) {
        return res.status(400).json({
          message: "No draftCVId on application — pass skillsWithEvidence explicitly",
        });
      }
      const draft = await DraftCV.findById(application.draftCVId).select("skills");
      if (!draft) {
        return res.status(404).json({ message: "Linked draft CV not found" });
      }
      resolved = (draft.skills || [])
        .filter((s) => Array.isArray(s.evidence) && s.evidence.length > 0)
        .map((s) => ({
          name: s.name,
          category: s.category,
          evidence: s.evidence,
          talkingPoint: s.talkingPoint || "",
        }));
    }

    if (!resolved.length) {
      return res.status(400).json({
        message: "No skills with evidence found. Re-generate skills in the CV builder first.",
      });
    }

    application.interviewPrep = application.interviewPrep || {};
    application.interviewPrep.isSaved = true;
    application.interviewPrep.savedAt = new Date();
    application.interviewPrep.skillsWithEvidence = resolved;
    await application.save();

    res.json({
      status: "ok",
      applicationId,
      savedAt: application.interviewPrep.savedAt,
      skillCount: resolved.length,
    });
  } catch (error) {
    console.error("[InterviewPrep] saveSkills failed:", error.message);
    res.status(500).json({ message: "Failed to save interview prep" });
  }
};

/**
 * List every prep the user has — applications with prep AND drafts with
 * standalone (CV-only) prep. Returned items use a unified shape so the
 * frontend list page treats them the same way.
 */
exports.list = async (req, res) => {
  try {
    const apps = await Application.find({
      userId: req.user.id,
      $or: [
        { "interviewPrep.isSaved": true },
        { "interviewPrep.jobQuestions.0": { $exists: true } },
      ],
    })
      .select(LIST_PROJECTION)
      .populate("jobId", "title company")
      .sort({ "interviewPrep.savedAt": -1, updatedAt: -1 })
      .lean();

    // Application IDs that already have prep — used to avoid double-listing
    // a draft whose prep is already represented through its application.
    const appDraftIds = new Set(
      apps.filter((a) => a.draftCVId).map((a) => String(a.draftCVId))
    );

    const drafts = await DraftCV.find({
      userId: req.user.id,
      "interviewPrep.isSaved": true,
    })
      .select({
        title: 1,
        "interviewPrep.isSaved": 1,
        "interviewPrep.savedAt": 1,
        "interviewPrep.skillsWithEvidence": 1,
        updatedAt: 1,
      })
      .sort({ "interviewPrep.savedAt": -1, updatedAt: -1 })
      .lean();

    const draftItems = drafts
      .filter((d) => !appDraftIds.has(String(d._id)))
      .map((d) => ({
        _id: d._id,
        source: "draft",
        // Mirror the Application shape so the frontend card renderer needs no
        // branching: title comes from the draft's name, no company.
        jobTitle: d.title || "CV draft",
        jobCompany: "",
        jobId: null,
        interviewPrep: d.interviewPrep,
        updatedAt: d.updatedAt,
      }));

    // Tag application items so the frontend can identify both sources.
    const appItems = apps.map((a) => ({ ...a, source: "application" }));

    // Merge + sort by most recently saved.
    const merged = [...appItems, ...draftItems].sort((a, b) => {
      const aDate = new Date(a.interviewPrep?.savedAt || a.updatedAt || 0).getTime();
      const bDate = new Date(b.interviewPrep?.savedAt || b.updatedAt || 0).getTime();
      return bDate - aDate;
    });

    res.json({ items: merged });
  } catch (error) {
    console.error("[InterviewPrep] list failed:", error.message);
    res.status(500).json({ message: "Failed to fetch interview prep list" });
  }
};

/**
 * Detail view for a single prep. The id can refer to either an Application or
 * a DraftCV (CV-only prep). Tries Application first; falls back to DraftCV.
 * Returns a unified shape that the frontend detail page consumes uniformly.
 */
exports.getOne = async (req, res) => {
  try {
    const { applicationId: id } = req.params;

    const application = await Application.findById(id)
      .populate("jobId", "title company description")
      .lean();
    if (application) {
      if (application.userId.toString() !== req.user.id) {
        return res.status(401).json({ message: "User not authorized" });
      }
      return res.json({ application: { ...application, source: "application" } });
    }

    // No matching application — try draft. Lets users open prep saved against
    // a CV that has no linked job analysis yet.
    const draft = await DraftCV.findById(id).lean();
    if (!draft) return res.status(404).json({ message: "Interview prep not found" });
    if (draft.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    // Shape it to match the Application schema the frontend expects, with
    // null job context to signal "CV-only" prep.
    const draftAsApplication = {
      _id: draft._id,
      source: "draft",
      jobId: null,
      jobTitle: draft.title || "CV draft",
      jobCompany: "",
      draftCVId: draft._id,
      interviewPrep: draft.interviewPrep,
    };
    return res.json({ application: draftAsApplication });
  } catch (error) {
    console.error("[InterviewPrep] getOne failed:", error.message);
    res.status(500).json({ message: "Failed to fetch interview prep" });
  }
};

/**
 * Update the user's free-text notes on a prep. Works for both Application-tied
 * prep and CV-only prep (Draft). Frontend autosaves on blur.
 */
exports.updateNotes = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { notes } = req.body;
    if (typeof notes !== "string") {
      return res.status(400).json({ message: "notes must be a string" });
    }

    const application = await Application.findById(id).select("userId interviewPrep");
    if (application) {
      if (application.userId.toString() !== req.user.id) {
        return res.status(401).json({ message: "User not authorized" });
      }
      application.interviewPrep = application.interviewPrep || {};
      application.interviewPrep.userNotes = notes;
      await application.save();
      return res.json({ status: "ok" });
    }

    const draft = await DraftCV.findById(id).select("userId interviewPrep");
    if (!draft) return res.status(404).json({ message: "Interview prep not found" });
    if (draft.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }
    draft.interviewPrep = draft.interviewPrep || {};
    draft.interviewPrep.userNotes = notes;
    await draft.save();

    res.json({ status: "ok" });
  } catch (error) {
    console.error("[InterviewPrep] updateNotes failed:", error.message);
    res.status(500).json({ message: "Failed to update notes" });
  }
};

/**
 * "Unsave" — drop user-saved skill prep but preserve auto-generated job
 * questions (those re-emerge if user runs analysis again).
 */
exports.remove = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const application = await Application.findById(applicationId).select("userId interviewPrep");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    application.interviewPrep = application.interviewPrep || {};
    application.interviewPrep.isSaved = false;
    application.interviewPrep.skillsWithEvidence = [];
    await application.save();

    res.json({ status: "ok" });
  } catch (error) {
    console.error("[InterviewPrep] remove failed:", error.message);
    res.status(500).json({ message: "Failed to remove interview prep" });
  }
};
