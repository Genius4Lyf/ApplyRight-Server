const crypto = require("crypto");
const Application = require("../models/Application");
const DraftCV = require("../models/DraftCV");
const settingsService = require("../services/settings.service");

// Allowed Story Bank themes — kept in sync with the enum on
// Application/DraftCV interviewPrep.stories[].theme.
const STORY_THEMES = [
  "leadership",
  "problem_solving",
  "conflict",
  "technical_achievement",
  "failure_learning",
  "teamwork",
  "impact",
];

// Project shape that the list page renders. Picks just what the card needs so
// the response stays small.
const LIST_PROJECTION = {
  jobTitle: 1,
  jobCompany: 1,
  jobId: 1,
  draftCVId: 1,
  status: 1,
  "interviewPrep.isSaved": 1,
  "interviewPrep.savedAt": 1,
  "interviewPrep.skillsWithEvidence": 1,
  "interviewPrep.jobQuestions": 1,
  "interviewPrep.questionsToAsk": 1,
  "interviewPrep.stories": 1,
  interviewQuestions: 1,
  questionsToAsk: 1,
  updatedAt: 1,
};

// Coerce whatever's stored on `interviewPrep.userNotes` (legacy string, null,
// or the new array) into the canonical array shape the frontend consumes.
// Legacy strings become a single "saved" note titled "Notes" so no content is
// lost. Returns a fresh array — does not mutate input.
const normalizeNotes = (raw) => {
  if (Array.isArray(raw)) {
    return raw.map((n) => ({
      id: n.id || crypto.randomUUID(),
      title: typeof n.title === "string" ? n.title : "",
      body: typeof n.body === "string" ? n.body : "",
      status: n.status === "draft" ? "draft" : "saved",
      createdAt: n.createdAt || null,
      updatedAt: n.updatedAt || null,
    }));
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return [
      {
        id: crypto.randomUUID(),
        title: "Notes",
        body: raw,
        status: "saved",
        createdAt: null,
        updatedAt: null,
      },
    ];
  }
  return [];
};

// Loads either an Application or DraftCV by id, with ownership check. Used by
// every endpoint that operates on a single prep regardless of which collection
// it lives in. Returns { doc, kind } where kind is 'application' or 'draft'.
const loadPrepDoc = async (id, userId, selectFields) => {
  const app = await Application.findById(id).select(selectFields);
  if (app) {
    if (app.userId.toString() !== userId) return { unauthorized: true };
    return { doc: app, kind: "application" };
  }
  const draft = await DraftCV.findById(id).select(selectFields);
  if (!draft) return { notFound: true };
  if (draft.userId.toString() !== userId) return { unauthorized: true };
  return { doc: draft, kind: "draft" };
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

      const sourceSkills =
        Array.isArray(skillsWithEvidence) && skillsWithEvidence.length
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

        const sorted = [...apps].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        return res.json({
          status: "ok",
          savedAt: now,
          skillCount: resolved.length,
          applicationCount: apps.length,
          id: sorted[0]?._id,
          source: "application",
          applicationId: sorted[0]?._id,
        });
      }

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
        { "interviewPrep.stories.0": { $exists: true } },
        { "interviewQuestions.0": { $exists: true } },
      ],
    })
      .select(LIST_PROJECTION)
      .populate("jobId", "title company")
      .sort({ "interviewPrep.savedAt": -1, updatedAt: -1 })
      .lean();

    const appDraftIds = new Set(apps.filter((a) => a.draftCVId).map((a) => String(a.draftCVId)));

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
        jobTitle: d.title || "CV draft",
        jobCompany: "",
        jobId: null,
        interviewPrep: d.interviewPrep,
        updatedAt: d.updatedAt,
      }));

    const appItems = apps.map((a) => ({ ...a, source: "application" }));

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

// Skills are a reference layer that auto-surfaces from the linked CV. Map the
// draft's skills-with-evidence into the prep shape (no confidence — reference,
// not a rated/practiced item).
const deriveSkillsFromDraft = (draftSkills) =>
  (Array.isArray(draftSkills) ? draftSkills : [])
    .filter((s) => Array.isArray(s.evidence) && s.evidence.length > 0)
    .map((s) => ({
      name: s.name,
      category: s.category,
      evidence: s.evidence,
      talkingPoint: s.talkingPoint || "",
    }));

/**
 * Detail view for a single prep. The id can refer to either an Application or
 * a DraftCV (CV-only prep). Tries Application first; falls back to DraftCV.
 * Returns a unified shape that the frontend detail page consumes uniformly.
 * Legacy single-string userNotes are folded into the array shape on read.
 *
 * Skill soundbites auto-surface: when none are saved on the prep, they're read
 * through from the linked CV so the user never has to "pull" them manually.
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
      const prep = application.interviewPrep || {};
      let skillsWithEvidence = Array.isArray(prep.skillsWithEvidence)
        ? prep.skillsWithEvidence
        : [];
      if (skillsWithEvidence.length === 0 && application.draftCVId) {
        const draft = await DraftCV.findById(application.draftCVId).select("skills").lean();
        if (draft) skillsWithEvidence = deriveSkillsFromDraft(draft.skills);
      }
      return res.json({
        application: {
          ...application,
          source: "application",
          // Support-granted loop override (read from the user) so the UI can show
          // all interviewers unlocked.
          unlockAllInterviewers: !!req.user.unlockAllInterviewers,
          interviewPrep: {
            ...prep,
            skillsWithEvidence,
            userNotes: normalizeNotes(prep.userNotes),
          },
        },
      });
    }

    const draft = await DraftCV.findById(id).lean();
    if (!draft) return res.status(404).json({ message: "Interview prep not found" });
    if (draft.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    const prep = draft.interviewPrep || {};
    const savedSkills = Array.isArray(prep.skillsWithEvidence) ? prep.skillsWithEvidence : [];
    const skillsWithEvidence = savedSkills.length ? savedSkills : deriveSkillsFromDraft(draft.skills);
    const draftAsApplication = {
      _id: draft._id,
      source: "draft",
      jobId: null,
      jobTitle: draft.title || "CV draft",
      jobCompany: "",
      draftCVId: draft._id,
      unlockAllInterviewers: !!req.user.unlockAllInterviewers,
      interviewPrep: { ...prep, skillsWithEvidence, userNotes: normalizeNotes(prep.userNotes) },
    };
    return res.json({ application: draftAsApplication });
  } catch (error) {
    console.error("[InterviewPrep] getOne failed:", error.message);
    res.status(500).json({ message: "Failed to fetch interview prep" });
  }
};

/**
 * Legacy single-textarea endpoint. Kept as a compat shim — folds the incoming
 * string into a single saved note rather than rejecting old clients.
 */
exports.updateNotes = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { notes } = req.body;
    if (typeof notes !== "string") {
      return res.status(400).json({ message: "notes must be a string" });
    }

    const { doc, kind, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const now = new Date();
    const existing = normalizeNotes(doc.interviewPrep.userNotes);
    if (existing.length === 0) {
      existing.push({
        id: crypto.randomUUID(),
        title: "Notes",
        body: notes,
        status: "saved",
        createdAt: now,
        updatedAt: now,
      });
    } else {
      existing[0] = {
        ...existing[0],
        body: notes,
        status: "saved",
        updatedAt: now,
      };
    }
    doc.interviewPrep.userNotes = existing;
    doc.markModified("interviewPrep.userNotes");
    await doc.save();

    res.json({ status: "ok", kind });
  } catch (error) {
    console.error("[InterviewPrep] updateNotes failed:", error.message);
    res.status(500).json({ message: "Failed to update notes" });
  }
};

/**
 * Create a new note on a prep (Application or Draft). Returns the full note
 * including server-assigned id and timestamps so the client can switch the
 * editor from a local draft into the persisted one.
 */
exports.createNote = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { title = "", body = "", status = "draft" } = req.body || {};
    if (typeof title !== "string" || typeof body !== "string") {
      return res.status(400).json({ message: "title and body must be strings" });
    }

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const notes = normalizeNotes(doc.interviewPrep.userNotes);
    const now = new Date();
    const note = {
      id: crypto.randomUUID(),
      title,
      body,
      status: status === "saved" ? "saved" : "draft",
      createdAt: now,
      updatedAt: now,
    };
    notes.unshift(note);
    doc.interviewPrep.userNotes = notes;
    doc.markModified("interviewPrep.userNotes");
    await doc.save();

    res.json({ note });
  } catch (error) {
    console.error("[InterviewPrep] createNote failed:", error.message);
    res.status(500).json({ message: "Failed to create note" });
  }
};

/**
 * Update title/body/status on an existing note. The frontend debounces
 * autosave calls into here every ~3s while a draft is being edited.
 */
exports.updateNote = async (req, res) => {
  try {
    const { applicationId: id, noteId } = req.params;
    const { title, body, status } = req.body || {};

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const notes = normalizeNotes(doc.interviewPrep.userNotes);
    const target = notes.find((n) => n.id === noteId);
    if (!target) return res.status(404).json({ message: "Note not found" });

    if (typeof title === "string") target.title = title;
    if (typeof body === "string") target.body = body;
    if (status === "draft" || status === "saved") target.status = status;
    target.updatedAt = new Date();

    doc.interviewPrep.userNotes = notes;
    doc.markModified("interviewPrep.userNotes");
    await doc.save();

    res.json({ note: target });
  } catch (error) {
    console.error("[InterviewPrep] updateNote failed:", error.message);
    res.status(500).json({ message: "Failed to update note" });
  }
};

/**
 * Delete a note by id.
 */
exports.deleteNote = async (req, res) => {
  try {
    const { applicationId: id, noteId } = req.params;

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const notes = normalizeNotes(doc.interviewPrep.userNotes);
    const next = notes.filter((n) => n.id !== noteId);
    if (next.length === notes.length) {
      return res.status(404).json({ message: "Note not found" });
    }
    doc.interviewPrep.userNotes = next;
    doc.markModified("interviewPrep.userNotes");
    await doc.save();

    res.json({ status: "ok" });
  } catch (error) {
    console.error("[InterviewPrep] deleteNote failed:", error.message);
    res.status(500).json({ message: "Failed to delete note" });
  }
};

/**
 * Set per-skill confidence (needs_work | almost | ready | null). Passing null
 * clears the marker. Skill is identified by its name (skills don't have stable
 * ids — they're re-derived from CV skills every time saveSkills runs).
 */
exports.updateSkillConfidence = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { skillName, confidence } = req.body || {};
    if (typeof skillName !== "string" || !skillName.trim()) {
      return res.status(400).json({ message: "skillName is required" });
    }
    const allowed = ["needs_work", "almost", "ready", null];
    if (!allowed.includes(confidence)) {
      return res.status(400).json({ message: "invalid confidence value" });
    }

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const skills = Array.isArray(doc.interviewPrep.skillsWithEvidence)
      ? doc.interviewPrep.skillsWithEvidence
      : [];
    const target = skills.find((s) => s.name === skillName);
    if (!target) return res.status(404).json({ message: "Skill not found on this prep" });

    target.confidence = confidence || undefined;
    doc.markModified("interviewPrep.skillsWithEvidence");
    await doc.save();

    res.json({ status: "ok", skillName, confidence: target.confidence || null });
  } catch (error) {
    console.error("[InterviewPrep] updateSkillConfidence failed:", error.message);
    res.status(500).json({ message: "Failed to update skill confidence" });
  }
};

/**
 * Detect whether the application's linked DraftCV has skills with evidence
 * that haven't yet been pulled into the prep. Drives the "Pull from CV" banner
 * on the prep detail page.
 *
 * `alreadySynced` is true when the prep's saved skill names match the draft's
 * skill names (with-evidence) AND the draft has not been updated since the
 * last save. If the draft is newer, we want the user to re-pull.
 */
// Return the candidate's UPLOADED resume text for this application, if any — so
// the prep page's "View CV" can show the upload when there's no ApplyRight-
// generated CV. Read-only, ownership-checked.
exports.getResumeText = async (req, res) => {
  try {
    const application = await Application.findById(req.params.applicationId).select(
      "userId resumeId"
    );
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }
    if (!application.resumeId) return res.status(200).json({ hasResume: false, rawText: "" });
    const Resume = require("../models/Resume");
    const resume = await Resume.findById(application.resumeId).select("rawText createdAt");
    const rawText = (resume && resume.rawText) || "";
    return res.status(200).json({
      hasResume: !!rawText.trim(),
      rawText,
      uploadedAt: resume?.createdAt || null,
    });
  } catch (error) {
    console.error("[InterviewPrep] getResumeText failed:", error.message);
    res.status(500).json({ message: "Failed to load the uploaded resume" });
  }
};

exports.getLinkedCV = async (req, res) => {
  try {
    const { applicationId: id } = req.params;

    const application = await Application.findById(id).select(
      "userId draftCVId interviewPrep updatedAt"
    );
    if (!application) {
      return res.json({ exists: false });
    }
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }
    if (!application.draftCVId) {
      return res.json({ exists: false });
    }

    const draft = await DraftCV.findById(application.draftCVId).select(
      "skills updatedAt interviewPrep"
    );
    if (!draft) {
      return res.json({ exists: false });
    }

    const draftSkillsWithEvidence = (draft.skills || []).filter(
      (s) => Array.isArray(s.evidence) && s.evidence.length > 0
    );

    if (draftSkillsWithEvidence.length === 0) {
      return res.json({ exists: false });
    }

    const savedSkills = (application.interviewPrep?.skillsWithEvidence || []).map((s) => s.name);
    const draftNames = draftSkillsWithEvidence.map((s) => s.name);

    const sameNames =
      savedSkills.length === draftNames.length &&
      savedSkills.every((n) => draftNames.includes(n));
    const savedAt = application.interviewPrep?.savedAt
      ? new Date(application.interviewPrep.savedAt).getTime()
      : 0;
    const draftUpdated = draft.updatedAt ? new Date(draft.updatedAt).getTime() : 0;
    const alreadySynced = sameNames && savedAt >= draftUpdated;

    res.json({
      exists: true,
      draftCVId: draft._id,
      generatedAt: draft.updatedAt,
      skillCount: draftSkillsWithEvidence.length,
      alreadySynced,
    });
  } catch (error) {
    console.error("[InterviewPrep] getLinkedCV failed:", error.message);
    res.status(500).json({ message: "Failed to detect linked CV" });
  }
};

/**
 * Set per-question confidence (needs_work | almost | ready | null) for job-based questions.
 */
exports.updateQuestionConfidence = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { questionText, questionIndex, confidence } = req.body || {};
    if (typeof questionText !== "string" || !questionText.trim()) {
      return res.status(400).json({ message: "questionText is required" });
    }
    const allowed = ["needs_work", "almost", "ready", null];
    if (!allowed.includes(confidence)) {
      return res.status(400).json({ message: "invalid confidence value" });
    }

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const questions = Array.isArray(doc.interviewPrep.jobQuestions)
      ? doc.interviewPrep.jobQuestions
      : [];

    let target = null;
    if (typeof questionIndex === "number" && questionIndex >= 0 && questionIndex < questions.length) {
      const candidate = questions[questionIndex];
      if (candidate && candidate.question === questionText) {
        target = candidate;
      }
    }

    if (!target) {
      target = questions.find((q) => q.question === questionText);
    }

    if (!target) return res.status(404).json({ message: "Question not found on this prep" });

    target.confidence = confidence || undefined;
    doc.markModified("interviewPrep.jobQuestions");
    await doc.save();

    res.json({ status: "ok", questionText, confidence: target.confidence || null });
  } catch (error) {
    console.error("[InterviewPrep] updateQuestionConfidence failed:", error.message);
    res.status(500).json({ message: "Failed to update question confidence" });
  }
};

/**
 * Set per-story confidence (needs_work | almost | ready | null). Stories carry
 * a stable `id`, so unlike skills/questions this matches by id, not text.
 */
exports.updateStoryConfidence = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { storyId, confidence } = req.body || {};
    if (typeof storyId !== "string" || !storyId.trim()) {
      return res.status(400).json({ message: "storyId is required" });
    }
    const allowed = ["needs_work", "almost", "ready", null];
    if (!allowed.includes(confidence)) {
      return res.status(400).json({ message: "invalid confidence value" });
    }

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const stories = Array.isArray(doc.interviewPrep.stories) ? doc.interviewPrep.stories : [];
    const target = stories.find((s) => s.id === storyId);
    if (!target) return res.status(404).json({ message: "Story not found on this prep" });

    target.confidence = confidence || undefined;
    doc.markModified("interviewPrep.stories");
    await doc.save();

    res.json({ status: "ok", storyId, confidence: target.confidence || null });
  } catch (error) {
    console.error("[InterviewPrep] updateStoryConfidence failed:", error.message);
    res.status(500).json({ message: "Failed to update story confidence" });
  }
};

/**
 * Create a story (manual "Add story"). Server assigns the id; appends to the end
 * so existing fabrication-warning indices stay valid. Returns the full story so
 * the client can switch its editor from a local draft to the persisted one.
 */
exports.createStory = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const body = req.body || {};

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const stories = Array.isArray(doc.interviewPrep.stories) ? doc.interviewPrep.stories : [];
    const story = {
      id: crypto.randomUUID(),
      title: typeof body.title === "string" ? body.title : "",
      theme: STORY_THEMES.includes(body.theme) ? body.theme : undefined,
      situation: typeof body.situation === "string" ? body.situation : "",
      task: typeof body.task === "string" ? body.task : "",
      action: typeof body.action === "string" ? body.action : "",
      result: typeof body.result === "string" ? body.result : "",
      skillsProven: Array.isArray(body.skillsProven)
        ? body.skillsProven.filter((x) => typeof x === "string")
        : [],
      answersQuestions: Array.isArray(body.answersQuestions)
        ? body.answersQuestions.filter((x) => typeof x === "string")
        : [],
      sourcedFrom: [],
    };
    stories.push(story);
    doc.interviewPrep.stories = stories;
    doc.markModified("interviewPrep.stories");
    await doc.save();

    res.json({ story });
  } catch (error) {
    console.error("[InterviewPrep] createStory failed:", error.message);
    res.status(500).json({ message: "Failed to create story" });
  }
};

/**
 * Update a story's editable fields. The frontend debounces autosave into here.
 * Editing the STAR content invalidates the AI fact-check for that story, so its
 * warning is dropped (the user's own words don't need grounding flags).
 */
exports.updateStory = async (req, res) => {
  try {
    const { applicationId: id, storyId } = req.params;
    const body = req.body || {};

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const stories = Array.isArray(doc.interviewPrep.stories) ? doc.interviewPrep.stories : [];
    const idx = stories.findIndex((s) => s.id === storyId);
    if (idx === -1) return res.status(404).json({ message: "Story not found" });
    const target = stories[idx];

    ["title", "situation", "task", "action", "result"].forEach((f) => {
      if (typeof body[f] === "string") target[f] = body[f];
    });
    if (STORY_THEMES.includes(body.theme)) target.theme = body.theme;
    if (Array.isArray(body.skillsProven)) {
      target.skillsProven = body.skillsProven.filter((x) => typeof x === "string");
    }
    if (Array.isArray(body.answersQuestions)) {
      target.answersQuestions = body.answersQuestions.filter((x) => typeof x === "string");
    }

    const warnings = doc.interviewPrep.storyFabricationWarnings;
    if (Array.isArray(warnings) && warnings.some((w) => w.index === idx)) {
      doc.interviewPrep.storyFabricationWarnings = warnings.filter((w) => w.index !== idx);
      doc.markModified("interviewPrep.storyFabricationWarnings");
    }
    doc.markModified("interviewPrep.stories");
    await doc.save();

    res.json({ story: target });
  } catch (error) {
    console.error("[InterviewPrep] updateStory failed:", error.message);
    res.status(500).json({ message: "Failed to update story" });
  }
};

/**
 * Delete a story by id. Drops its fabrication warning and shifts higher indices
 * down by one so the index-keyed warnings stay aligned with the array.
 */
exports.deleteStory = async (req, res) => {
  try {
    const { applicationId: id, storyId } = req.params;

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const stories = Array.isArray(doc.interviewPrep.stories) ? doc.interviewPrep.stories : [];
    const idx = stories.findIndex((s) => s.id === storyId);
    if (idx === -1) return res.status(404).json({ message: "Story not found" });

    stories.splice(idx, 1);
    doc.interviewPrep.stories = stories;

    const warnings = doc.interviewPrep.storyFabricationWarnings;
    if (Array.isArray(warnings)) {
      doc.interviewPrep.storyFabricationWarnings = warnings
        .filter((w) => w.index !== idx)
        .map((w) => (w.index > idx ? { ...w, index: w.index - 1 } : w));
      doc.markModified("interviewPrep.storyFabricationWarnings");
    }
    doc.markModified("interviewPrep.stories");
    await doc.save();

    res.json({ status: "ok" });
  } catch (error) {
    console.error("[InterviewPrep] deleteStory failed:", error.message);
    res.status(500).json({ message: "Failed to delete story" });
  }
};

/**
 * Grade a user's mock interview response using Google Gemini, charge 1 credit,
 * log the transaction, and save the rating based on score.
 */
exports.gradeAnswer = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { questionText, questionIndex, answerText } = req.body || {};

    if (!questionText || typeof questionText !== "string") {
      return res.status(400).json({ message: "questionText is required" });
    }
    if (!answerText || typeof answerText !== "string" || !answerText.trim()) {
      return res.status(400).json({ message: "answerText is required" });
    }

    const application = await Application.findById(id).populate("jobId");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    const User = require("../models/User");
    const Transaction = require("../models/Transaction");
    const aiService = require("../services/ai.service");
    const subscription = require("../services/subscription.service");
    const { buildInterviewCandidateContext } = require("./analysis.controller");

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const GRADE_COST = (await settingsService.getCreditCosts()).GRADE_ANSWER;
    // Paid-only route (requireTier); now also spends credits from the tier
    // allowance first, then the wallet.
    if (subscription.availableCredits(user) < GRADE_COST) {
      return res.status(403).json({
        message: "Insufficient credits to grade response. Buy credits or watch an ad to earn more.",
        code: "INSUFFICIENT_CREDITS",
      });
    }

    const questions = Array.isArray(application.interviewPrep?.jobQuestions)
      ? application.interviewPrep.jobQuestions
      : [];

    let suggestedAnswer = "";
    let questionObj = null;

    if (typeof questionIndex === "number" && questionIndex >= 0 && questionIndex < questions.length) {
      const candidate = questions[questionIndex];
      if (candidate && candidate.question === questionText) {
        suggestedAnswer = candidate.suggestedAnswer || "";
        questionObj = candidate;
      }
    }

    if (!questionObj) {
      questionObj = questions.find((q) => q.question === questionText);
      if (questionObj) {
        suggestedAnswer = questionObj.suggestedAnswer || "";
      }
    }

    const jobDescription = application.jobId?.description || application.jobTitle || "";
    const candidateContext = await buildInterviewCandidateContext(application, {
      userId: req.user.id,
      applicationId: application._id,
    });

    const aiResult = await aiService.gradeInterviewAnswer(
      questionText,
      answerText,
      suggestedAnswer,
      jobDescription,
      candidateContext,
      { userId: req.user.id, applicationId: application._id }
    );

    // Charge (or skip for paid). chargeOrSkip does the atomic balance-guarded
    // deduction + Transaction record, or — for an active paid tier — records a
    // zero-cost usage Transaction and skips the charge.
    const charge = await subscription.chargeOrSkip(user, GRADE_COST, {
      type: "usage",
      description: `AI grade mock answer: "${questionText.substring(0, 40)}..."`,
    });
    if (charge.insufficient) {
      return res.status(403).json({
        message: "Insufficient credits to grade response. Watch an ad to earn credits.",
        code: "INSUFFICIENT_CREDITS",
      });
    }

    // Normalize the AI score to a clamped integer before it drives the dial,
    // the readiness thresholds, and the response.
    const score = Math.max(0, Math.min(100, Math.round(Number(aiResult.score) || 0)));

    // Save auto-determined confidence based on score
    let autoConfidence = "needs_work";
    if (score > 75) {
      autoConfidence = "ready";
    } else if (score > 45) {
      autoConfidence = "almost";
    }

    let attempts = [];
    if (questionObj) {
      questionObj.confidence = autoConfidence;
      // Record this attempt. Truncate the answer and cap to the last 10 so the
      // document (and the prep-list payload) stays bounded.
      const prior = Array.isArray(questionObj.attempts) ? questionObj.attempts : [];
      const next = [
        ...prior,
        { score, answer: answerText.slice(0, 600), createdAt: new Date() },
      ].slice(-10);
      questionObj.attempts = next;
      attempts = next;
      application.markModified("interviewPrep.jobQuestions");
      await application.save();
    }

    res.json({
      score,
      overallFeedback: aiResult.overallFeedback,
      starBreakdown: aiResult.starBreakdown,
      refinedAnswer: aiResult.refinedAnswer,
      confidence: autoConfidence,
      attempts,
      remainingCredits: subscription.availableCredits(user),
    });
  } catch (error) {
    console.error("[InterviewPrep] gradeAnswer failed:", error.message);
    res.status(500).json({ message: "Failed to grade mock interview response" });
  }
};

/**
 * Adaptive interviewer: take the question + the candidate's answer and return
 * ONE dynamic follow-up question (the premium "real interview" upgrade). Charges
 * 1 credit, only AFTER the AI produces a usable follow-up.
 */
exports.generateFollowUp = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { questionText, answerText } = req.body || {};

    if (!questionText || typeof questionText !== "string") {
      return res.status(400).json({ message: "questionText is required" });
    }
    if (!answerText || typeof answerText !== "string" || !answerText.trim()) {
      return res.status(400).json({ message: "answerText is required" });
    }

    const application = await Application.findById(id).populate("jobId");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    const User = require("../models/User");
    const Transaction = require("../models/Transaction");
    const aiService = require("../services/ai.service");
    const subscription = require("../services/subscription.service");

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const FOLLOWUP_COST = (await settingsService.getCreditCosts()).FOLLOWUP;
    // Paid-only route (requireTier); now also spends credits (tier allowance first).
    if (subscription.availableCredits(user) < FOLLOWUP_COST) {
      return res.status(403).json({
        message: "Insufficient credits for a follow-up. Buy credits or watch an ad to earn more.",
        code: "INSUFFICIENT_CREDITS",
      });
    }

    // AI first — if it throws (mock / no key), we never reach the deduction.
    const aiResult = await aiService.generateFollowUp(
      questionText,
      answerText,
      {
        jobTitle: application.jobTitle || application.jobId?.title || "",
        company: application.jobCompany || application.jobId?.company || "",
      },
      { userId: req.user.id, applicationId: application._id }
    );

    if (!aiResult.followUp) {
      // Nothing usable produced — don't charge.
      return res.status(200).json({ followUp: "", remainingCredits: subscription.availableCredits(user) });
    }

    // Charge (or skip for an active paid tier).
    const charge = await subscription.chargeOrSkip(user, FOLLOWUP_COST, {
      type: "usage",
      description: "AI interview follow-up question",
    });
    if (charge.insufficient) {
      return res.status(403).json({
        message: "Insufficient credits for a follow-up. Watch an ad to earn credits.",
        code: "INSUFFICIENT_CREDITS",
      });
    }

    res.status(200).json({ followUp: aiResult.followUp, remainingCredits: subscription.availableCredits(user) });
  } catch (error) {
    console.error("[InterviewPrep] generateFollowUp failed:", error.message);
    if (error.name === "AIUnavailableError" || error.code === "AI_UNAVAILABLE") {
      return res
        .status(503)
        .json({ message: "The AI interviewer is temporarily unavailable.", code: "AI_UNAVAILABLE" });
    }
    res.status(500).json({ message: "Failed to generate a follow-up" });
  }
};

/**
 * Conversational Interview Mode: one turn of a live, turn-based interview. The
 * client owns the transcript + question spine and resends them each turn (the
 * server stays stateless). Reacts to the candidate's actual answer, grounded in
 * their CV + the job, and returns what to SAY (TTS) plus the QUESTION to show.
 *
 * FREE during testing — no credits are charged. When Interview Mode becomes a
 * paid (Plus-tier) feature, add the tier gate to the route and the atomic charge
 * at the marked site below (mirror generateFollowUp's deduction).
 */
exports.conversationTurn = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { questionSpine, spineIndex, transcript, lastAnswer, phase } = req.body || {};

    const application = await Application.findById(id).populate("jobId");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    const aiService = require("../services/ai.service");
    const { buildInterviewCandidateContext } = require("./analysis.controller");

    const candidateContext = await buildInterviewCandidateContext(application, {
      userId: req.user.id,
      applicationId: application._id,
    });
    const jobDescription = application.jobId?.description || application.jobTitle || "";

    // NOTE: when Interview Mode becomes a paid Plus-tier feature, charge here —
    // mirror generateFollowUp: an atomic, balance-guarded
    //   User.updateOne({ _id, credits: { $gte: COST } }, { $inc: { credits: -COST } })
    // followed by Transaction.create({ ..., type: "usage" }). Free during testing.

    const result = await aiService.conversationTurn(
      {
        questionSpine: Array.isArray(questionSpine) ? questionSpine : [],
        spineIndex: Number.isInteger(spineIndex) ? spineIndex : 0,
        transcript: Array.isArray(transcript) ? transcript : [],
        lastAnswer: typeof lastAnswer === "string" ? lastAnswer : "",
        phase: phase === "answer" ? "answer" : "greeting",
      },
      candidateContext,
      {
        jobTitle: application.jobTitle || application.jobId?.title || "",
        company: application.jobCompany || application.jobId?.company || "",
        jobDescription,
      },
      { userId: req.user.id, applicationId: application._id }
    );

    res.status(200).json(result);
  } catch (error) {
    console.error("[InterviewPrep] conversationTurn failed:", error.message);
    if (error.name === "AIUnavailableError" || error.code === "AI_UNAVAILABLE") {
      return res
        .status(503)
        .json({ message: "The AI interviewer is temporarily unavailable.", code: "AI_UNAVAILABLE" });
    }
    res.status(500).json({ message: "Failed to continue the interview" });
  }
};

/**
 * Realtime (live voice) Interview Mode: mint a short-lived OpenAI ephemeral
 * client secret. The browser does the WebRTC handshake DIRECTLY with OpenAI
 * using this secret — audio never flows through our backend. The candidate's
 * CV + job grounding rides in the session `instructions`.
 *
 * Metered in live-interview minutes (not credits): free spends its 5-min taste,
 * paid spends its balance. Reserve-then-reconcile bounds OpenAI cost. The intro
 * slider sends a requestedSec (paid only) and a wrapUp toggle; the wrap-up window
 * draws from the same reservation so it is billed too. SECURITY: never log the secret.
 */
// Return the cached interview roster, generating + persisting it once on a miss.
// The roster is JD-derived (NOT style-driven) and includes a per-seat description,
// so it's generated a single time per application and reused for the prep preview,
// the "pick your interviewer" chooser, and the live session. Regenerates only if
// missing or stale (pre-description cache). Degrades to a deterministic fallback
// inside ai.service, so this never throws on AI being unavailable.
const loadOrGeneratePanel = async (application, jobMeta, fit, _style, meta = {}) => {
  const cached = application.interviewPrep?.panel;
  // Require gender too, so pre-gender cached panels (whose voices were assigned by
  // seat index, not gender) regenerate with gender-matched voices.
  const hasDescriptions =
    Array.isArray(cached?.seats) &&
    cached.seats.length >= 2 &&
    cached.seats.every((s) => s && s.description && s.gender);
  if (hasDescriptions) return cached.seats;

  const aiService = require("../services/ai.service");
  const seats = await aiService.buildInterviewPanel(jobMeta, fit, "", meta);
  application.interviewPrep = application.interviewPrep || {};
  application.interviewPrep.panel = { generatedAt: new Date(), seats };
  await application.save();
  return seats;
};

// Interview LOOP access: Premium users pick any panel interviewer in any order —
// there is no score-based sequential unlock. Always-true helper (name + signature
// preserved so callers keep working); the separate readiness gate
// (computeInterviewGate) still governs whether the loop is startable at all.
// eslint-disable-next-line no-unused-vars
const seatUnlocked = (seatIndex, rounds = [], unlockAll = false) => true;

// Split a reservation's total seconds across N panel seats (multi-voice). Each
// seat runs as its own realtime session capped to its slice, so the SUM of caps
// equals reservedSec — total OpenAI exposure stays bounded by what we reserved,
// no matter how the client paces the handoffs. The LAST seat carries the wrap-up
// grace (it delivers the closing). Computed identically in createRealtimeSession
// (seat 0) and mintRealtimeSegment (seats 1..N-1) so budgets line up.
const REALTIME_GRACE_DEFAULT = 90;
const panelSegmentBudgets = (reservedSec, n, wrapUpOn) => {
  const base = Math.floor(reservedSec / n);
  return Array.from({ length: n }, (_, i) => {
    const seg = i < n - 1 ? base : reservedSec - base * (n - 1); // last seat gets the remainder
    const isLast = i === n - 1;
    const graceSec =
      isLast && wrapUpOn
        ? Math.min(Number(process.env.REALTIME_GRACE_SEC) || REALTIME_GRACE_DEFAULT, seg)
        : 0;
    return { seatIndex: i, maxSessionSec: seg, mainSec: seg - graceSec, graceSec, isLast };
  });
};

// Build the jobMeta + fit pair used for both panel generation and realtime
// instructions, from a populated Application. Mirrors the inline build in
// createRealtimeSession so the preview endpoint stays in sync.
const panelInputsFromApplication = (application) => {
  const jobMeta = {
    jobTitle: application.jobTitle || application.jobId?.title || "",
    company: application.jobCompany || application.jobId?.company || "",
    jobDescription: application.jobId?.description || application.jobDescription || "",
  };
  const fa = application.fitAnalysis || {};
  const mustHaveNames = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .filter((s) => s && s.importance === "must_have" && s.name)
      .map((s) => s.name);
  const fit = {
    matchedMustHaves: mustHaveNames(fa.matchedSkills),
    missingMustHaves: mustHaveNames(fa.missingSkills),
    experienceNote: fa.experienceAnalysis?.match === false ? fa.experienceAnalysis?.feedback || "" : "",
    seniorityNote: fa.seniorityAnalysis?.match === false ? fa.seniorityAnalysis?.feedback || "" : "",
  };
  return { jobMeta, fit };
};

/**
 * GET /:applicationId/panel — the "who's likely to interview you" preview.
 * PAID tiers get the real 3-person panel (HR + 2 JD-derived seats), generated +
 * cached. FREE tier gets a GENERIC teaser (no AI call, no cost) so the prep
 * screen can show a blurred upsell without us paying generation for non-buyers.
 */
exports.getInterviewPanel = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const ALLOWED_STYLES = ["balanced", "screening", "technical", "behavioral"];
    const style = ALLOWED_STYLES.includes(req.query.style) ? req.query.style : "balanced";

    const application = await Application.findById(id).populate("jobId");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    const subscription = require("../services/subscription.service");
    const aiService = require("../services/ai.service");
    const UserModel = require("../models/User");
    const user = await UserModel.findById(req.user.id);

    const { jobMeta, fit } = panelInputsFromApplication(application);

    // Free tier → generic teaser (no AI spend). Paid → real, cached panel.
    if (subscription.panelModeForUser(user) === "solo") {
      return res
        .status(200)
        .json({ panel: aiService.interviewPanelTeaser(jobMeta.jobTitle), style, teaser: true });
    }

    const seats = await loadOrGeneratePanel(application, jobMeta, fit, style, {
      userId: req.user.id,
      applicationId: application._id,
    });
    res.status(200).json({ panel: seats, style, teaser: false });
  } catch (error) {
    console.error("[InterviewPrep] getInterviewPanel failed:", error.message);
    res.status(500).json({ message: "Failed to load the interview panel" });
  }
};

exports.createRealtimeSession = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const {
      questionSpine,
      timeOfDay,
      candidateName,
      voice,
      style,
      requestedSec,
      wrapUp,
      challenge,
      interviewerSeatIndex, // pick-a-role: which roster seat runs this 1:1 round
    } = req.body || {};

    const application = await Application.findById(id).populate("jobId");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    const aiService = require("../services/ai.service");
    const realtime = require("../services/realtime.service");
    const { buildInterviewCandidateContext } = require("./analysis.controller");

    const candidateContext = await buildInterviewCandidateContext(application, {
      userId: req.user.id,
      applicationId: application._id,
    });
    // Is this interview grounded in the candidate's CV? (Has real experience or a
    // summary to reference.) When false, the interviewer can't reference their
    // background — the client warns the user so they can attach a CV/resume.
    const cvGrounded = !!(
      candidateContext &&
      ((Array.isArray(candidateContext.experience) && candidateContext.experience.length > 0) ||
        (typeof candidateContext.summary === "string" && candidateContext.summary.trim()))
    );
    const jobMeta = {
      jobTitle: application.jobTitle || application.jobId?.title || "",
      company: application.jobCompany || application.jobId?.company || "",
      jobDescription: application.jobId?.description || application.jobDescription || "",
    };

    // Fit/gap data lets the interviewer probe missing must-have skills + test the
    // ones the candidate claims — like a real interviewer.
    const fa = application.fitAnalysis || {};
    const mustHaveNames = (arr) =>
      (Array.isArray(arr) ? arr : [])
        .filter((s) => s && s.importance === "must_have" && s.name)
        .map((s) => s.name);
    const fit = {
      matchedMustHaves: mustHaveNames(fa.matchedSkills),
      missingMustHaves: mustHaveNames(fa.missingSkills),
      experienceNote: fa.experienceAnalysis?.match === false ? fa.experienceAnalysis?.feedback || "" : "",
      seniorityNote: fa.seniorityAnalysis?.match === false ? fa.seniorityAnalysis?.feedback || "" : "",
    };

    // ---- Live-minute gate + reservation (reserve-then-reconcile) ----
    // Audio is WebRTC-direct to OpenAI, so we can't observe duration live. Reserve
    // up front against the user's balance, hard-cap the minted session to the
    // reservation, then refund the unused remainder when the client reports the
    // real duration in assessInterview. This bounds OpenAI cost no matter what the
    // client later claims.
    const subscription = require("../services/subscription.service");
    const { FREE_TASTE_SEC } = require("../config/catalog");
    const UserModel = require("../models/User");

    const user = await UserModel.findById(req.user.id);
    const eff = subscription.getEffectiveTier(user);
    const li = user.liveInterview || {};
    // The minute economy is INDEPENDENT of the tier enum: any user (even free
    // tier) can hold purchased minutes — a subscription allowance, a top-up, or a
    // ₦600 Practice Pass — in liveInterview.secondsRemaining. We spend PURCHASED
    // minutes first and fall back to the lifetime free taste only when there are
    // none. The reservation `mode` ("paid" vs "free") records which source funded
    // this session, and assessInterview keys the scorecard gate off it (paid
    // minutes always unlock the score, even for a free-tier Practice Pass buyer).
    const paidAvail = Math.max(0, li.secondsRemaining || 0);
    const freeAvail = Math.max(0, FREE_TASTE_SEC - (li.freeTasteUsedSec || 0));
    const useFreeTaste = paidAvail <= 0; // only when there are no purchased minutes
    const avail = useFreeTaste ? freeAvail : paidAvail;

    if (avail <= 0) {
      return res.status(402).json({
        message:
          eff === "free"
            ? "You've used your free interview minutes. Upgrade to keep practicing."
            : "You're out of interview minutes. Upgrade or grab a top-up.",
        code: "NO_MINUTES",
      });
    }

    // The intro slider sets the TOTAL session length (the main interview PLUS the
    // wrap-up) — 5–15 min for paid, capped by their remaining balance. Free has no
    // slider (fixed 5-min taste). The wrap-up is carved out of the session (so the
    // host always gets to close), leaving the rest for the actual interview.
    const planCap = subscription.maxSessionSecForTier(user);
    const budgetCap = Math.max(0, Math.min(planCap, avail));

    // Wrap-up window (default on). Toggle off => hard cut at time-up.
    const wrapUpOn = wrapUp !== false; // default true when omitted
    const graceWanted = wrapUpOn ? Number(process.env.REALTIME_GRACE_SEC) || 90 : 0;

    // reservedSec = the whole session the user picked (the OpenAI hard cap),
    // bounded by the per-tier cap and their balance.
    // A length was picked via the slider only when spending purchased minutes
    // (the slider is hidden for the fixed free taste). Honor it; else use the cap.
    const sessionWant =
      !useFreeTaste && Number(requestedSec) > 0 ? Math.round(Number(requestedSec)) : budgetCap;
    const reservedSec = Math.max(0, Math.min(budgetCap, sessionWant));

    // Carve the wrap-up out of the session, but never let it eat the whole thing
    // (keep >= 60s of actual interview when there's room). The client runs main
    // then grace inside reservedSec; reconciliation bills the actual duration.
    const graceSec = Math.max(0, Math.min(graceWanted, Math.max(0, reservedSec - 60)));
    const mainSec = Math.max(0, reservedSec - graceSec);
    if (reservedSec <= 0) {
      return res.status(402).json({
        message: "Could not reserve interview minutes. Please try again.",
        code: "NO_MINUTES",
      });
    }

    const reservationId = require("crypto").randomUUID();
    const startedAt = new Date();

    // Atomic reservation: the guard ensures two concurrent sessions can't both
    // spend the same balance (mirrors the credit-deduction $gte guard pattern).
    let reserved;
    if (useFreeTaste) {
      reserved = await UserModel.updateOne(
        { _id: user._id, "liveInterview.freeTasteUsedSec": { $lte: FREE_TASTE_SEC - reservedSec } },
        {
          $inc: { "liveInterview.freeTasteUsedSec": reservedSec },
          $set: {
            "liveInterview.activeReservation": {
              reservationId,
              reservedSec,
              startedAt,
              mode: "free",
              segmentsMinted: 1,
            },
          },
        }
      );
    } else {
      reserved = await UserModel.updateOne(
        { _id: user._id, "liveInterview.secondsRemaining": { $gte: reservedSec } },
        {
          $inc: { "liveInterview.secondsRemaining": -reservedSec },
          $set: {
            "liveInterview.activeReservation": {
              reservationId,
              reservedSec,
              startedAt,
              mode: "paid",
              segmentsMinted: 1,
            },
          },
        }
      );
    }
    if (reserved.modifiedCount === 0) {
      return res.status(402).json({
        message: "Could not reserve interview minutes. Please try again.",
        code: "NO_MINUTES",
      });
    }

    const ALLOWED_STYLES = ["balanced", "screening", "technical", "behavioral"];
    const safeStyle = ALLOWED_STYLES.includes(style) ? style : "balanced";
    const ALLOWED_CHALLENGE = ["gentle", "realistic", "tough"];
    const safeChallenge = ALLOWED_CHALLENGE.includes(challenge) ? challenge : "realistic";

    // Panel: paid tiers are interviewed by a 3-person panel (HR + 2 JD-derived).
    // Load-or-generate+cache the panel for this style so the prep-screen preview
    // and this live session show the SAME people. Free tier = solo (no panel).
    const panelMode = subscription.panelModeForUser(user);
    let panelSeats = [];
    if (panelMode !== "solo") {
      panelSeats = await loadOrGeneratePanel(application, jobMeta, fit, safeStyle, {
        userId: req.user.id,
        applicationId: application._id,
      });
    }

    // PICK-A-ROLE (paid): the candidate chose ONE roster interviewer to run this
    // round 1:1, in that interviewer's own voice. A focused single session — no
    // panel, no segments, no tools. This is the unit of the interview "loop".
    const seatIdx = Number(interviewerSeatIndex);
    if (
      panelMode !== "solo" &&
      Number.isInteger(seatIdx) &&
      seatIdx >= 0 &&
      seatIdx < panelSeats.length
    ) {
      // Premium picks any interviewer in any order — no score-based unlock gate.
      const chosen = panelSeats[seatIdx];
      const ivInstructions = aiService.buildRealtimeInstructions(
        candidateContext,
        jobMeta,
        Array.isArray(questionSpine) ? questionSpine : [],
        Math.max(1, Math.round(mainSec / 60)),
        {
          timeOfDay: typeof timeOfDay === "string" ? timeOfDay : "",
          candidateName: typeof candidateName === "string" ? candidateName.slice(0, 40) : "",
          fit,
          style: safeStyle,
          challenge: safeChallenge,
          interviewer: { name: chosen.name, role: chosen.role, focus: chosen.focus },
        }
      );
      const ivModel = subscription.modelForUser(user);
      let ivSession;
      try {
        ivSession = await realtime.mintRealtimeSession({
          instructions: ivInstructions,
          voice: chosen.voice, // the chosen interviewer's own voice
          model: ivModel,
          maxSessionSec: reservedSec,
        });
      } catch (mintErr) {
        await UserModel.updateOne(
          { _id: user._id, "liveInterview.activeReservation.reservationId": reservationId },
          {
            $inc: { "liveInterview.secondsRemaining": reservedSec },
            $set: { "liveInterview.activeReservation": {} },
          }
        ).catch(() => {});
        throw mintErr;
      }
      return res.status(200).json({
        clientSecret: ivSession.clientSecret,
        expiresAt: ivSession.expiresAt,
        model: ivSession.model,
        voice: ivSession.voice,
        mainSec,
        graceSec,
        maxSessionSec: ivSession.maxSessionSec,
        reservationId,
        reservedSec,
        // Echo the chosen interviewer so the UI shows who's interviewing this round.
        interviewer: { seatIndex: seatIdx, name: chosen.name, role: chosen.role, focus: chosen.focus },
        panelMode: "single-interviewer",
        cvGrounded,
      });
    }

    // MULTI-VOICE (Premium): run the panel as one realtime session PER seat. Mint
    // ONLY seat 0 (HR) now; the client calls /realtime-segment for seats 1..N-1
    // under this SAME reservation. Each session is capped to its slice so total
    // OpenAI exposure never exceeds reservedSec (panelSegmentBudgets).
    if (panelMode === "multi-voice" && panelSeats.length >= 2) {
      const N = panelSeats.length;
      const budgets = panelSegmentBudgets(reservedSec, N, wrapUpOn);
      const seg0 = budgets[0];
      const seat0 = panelSeats[0];

      const seg0Instructions = aiService.buildRealtimeInstructions(
        candidateContext,
        jobMeta,
        Array.isArray(questionSpine) ? questionSpine : [],
        Math.max(1, Math.round(seg0.mainSec / 60)),
        {
          timeOfDay: typeof timeOfDay === "string" ? timeOfDay : "",
          candidateName: typeof candidateName === "string" ? candidateName.slice(0, 40) : "",
          fit,
          style: safeStyle,
          challenge: safeChallenge,
          panel: panelSeats,
          panelMode,
          segment: { index: 0, isFirst: true, isLast: N === 1 },
        }
      );

      const model = subscription.modelForUser(user);
      let seg0Session;
      try {
        seg0Session = await realtime.mintRealtimeSession({
          instructions: seg0Instructions,
          voice: seat0.voice,
          model,
          maxSessionSec: seg0.maxSessionSec,
          // Seat 0 hands off to seat 1 via the tool (unless it's a 1-seat panel).
          enableHandoff: N > 1,
        });
      } catch (mintErr) {
        // Multi-voice is paid-only → release the paid reservation on mint failure.
        await UserModel.updateOne(
          { _id: user._id, "liveInterview.activeReservation.reservationId": reservationId },
          {
            $inc: { "liveInterview.secondsRemaining": reservedSec },
            $set: { "liveInterview.activeReservation": {} },
          }
        ).catch(() => {});
        throw mintErr;
      }

      return res.status(200).json({
        clientSecret: seg0Session.clientSecret,
        expiresAt: seg0Session.expiresAt,
        model: seg0Session.model,
        voice: seg0Session.voice,
        mainSec: seg0.mainSec,
        graceSec: seg0.graceSec,
        maxSessionSec: seg0Session.maxSessionSec,
        reservationId,
        reservedSec,
        panel: panelSeats,
        panelMode,
        cvGrounded,
        // Per-seat plan the client drives: it mints seats 1..N-1 via
        // /realtime-segment as each prior seat's time runs out.
        segments: budgets.map((b) => ({
          seatIndex: b.seatIndex,
          name: panelSeats[b.seatIndex].name,
          role: panelSeats[b.seatIndex].role,
          voice: panelSeats[b.seatIndex].voice,
          mainSec: b.mainSec,
          graceSec: b.graceSec,
        })),
      });
    }

    const instructions = aiService.buildRealtimeInstructions(
      candidateContext,
      jobMeta,
      Array.isArray(questionSpine) ? questionSpine : [],
      Math.max(1, Math.round(mainSec / 60)), // interviewer's speaking budget (grace is the wrap-up on top)
      {
        timeOfDay: typeof timeOfDay === "string" ? timeOfDay : "",
        candidateName: typeof candidateName === "string" ? candidateName.slice(0, 40) : "",
        fit,
        style: safeStyle,
        challenge: safeChallenge,
        panel: panelSeats,
        panelMode,
      }
    );

    // Premium (pro) tier gets the sharper full model; others the cheaper mini.
    const model = subscription.modelForUser(user);

    // voice is validated against the allowlist inside the service. If minting
    // fails after we reserved, release the reservation so minutes aren't lost.
    let session;
    try {
      session = await realtime.mintRealtimeSession({
        instructions,
        voice,
        model,
        maxSessionSec: reservedSec,
        // Single-voice panel: the model drives the on-screen "who's speaking"
        // highlight by calling set_active_speaker as it switches between panelists.
        enableSpeakerTool: panelMode === "single-voice" && panelSeats.length >= 2,
      });
    } catch (mintErr) {
      // Refund the SAME bucket we reserved from (paid minutes vs free taste), not
      // by tier — a free-tier Practice Pass session reserves from secondsRemaining.
      const refund = useFreeTaste
        ? { $inc: { "liveInterview.freeTasteUsedSec": -reservedSec } }
        : { $inc: { "liveInterview.secondsRemaining": reservedSec } };
      await UserModel.updateOne(
        { _id: user._id, "liveInterview.activeReservation.reservationId": reservationId },
        { ...refund, $set: { "liveInterview.activeReservation": {} } }
      ).catch(() => {});
      throw mintErr;
    }

    res.status(200).json({
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt,
      model: session.model,
      voice: session.voice,
      // Client drives its main countdown from mainSec; the grace window runs AFTER
      // it. Both live inside reservedSec (the OpenAI hard cap), so all of it bills.
      mainSec,
      // Wrap-up window (seconds) the client runs after the main time ends so the
      // interviewer can verbally close out. 0 when the user turned wrap-up off.
      graceSec,
      // maxSessionSec = the full reserved budget (main + grace) = the OpenAI cap.
      maxSessionSec: session.maxSessionSec,
      // Echoed back to assess-interview so we reconcile the right reservation.
      reservationId,
      reservedSec,
      // The interview panel (empty for free/solo). Lets the UI show the 3
      // interviewers ("who's likely to interview you") on the connecting screen.
      panel: panelSeats,
      panelMode,
      cvGrounded,
    });
  } catch (error) {
    // Log only the message — never the secret or the OpenAI response body.
    console.error("[InterviewPrep] createRealtimeSession failed:", error.message);
    if (
      error.code === "REALTIME_UNAVAILABLE" ||
      error.code === "AI_UNAVAILABLE" ||
      error.name === "AIUnavailableError"
    ) {
      return res
        .status(503)
        .json({ message: "The live interviewer is temporarily unavailable.", code: "REALTIME_UNAVAILABLE" });
    }
    res.status(500).json({ message: "Failed to start the live interview" });
  }
};

/**
 * POST /:applicationId/realtime-segment — mint the NEXT panel seat's realtime
 * session for a Premium MULTI-VOICE interview. Runs UNDER the reservation already
 * created by createRealtimeSession — it reserves NO new minutes, it only mints
 * another short-lived OpenAI session with that seat's distinct voice. Guarded so a
 * client can't open unbounded paid sessions on one reservation (cost control).
 */
exports.mintRealtimeSegment = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { reservationId, seatIndex, timeOfDay, candidateName, style, questionSpine, challenge } =
      req.body || {};

    const application = await Application.findById(id).populate("jobId");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    const subscription = require("../services/subscription.service");
    const aiService = require("../services/ai.service");
    const realtime = require("../services/realtime.service");
    const UserModel = require("../models/User");
    const { buildInterviewCandidateContext } = require("./analysis.controller");

    const user = await UserModel.findById(req.user.id);
    if (subscription.panelModeForUser(user) !== "multi-voice") {
      return res
        .status(403)
        .json({ message: "The multi-voice panel is a Premium feature.", code: "TIER_REQUIRED" });
    }

    // Must run under the live reservation minted by createRealtimeSession.
    const ar = user?.liveInterview?.activeReservation;
    if (!ar || !ar.reservationId || ar.reservationId !== reservationId || ar.mode !== "paid") {
      return res
        .status(409)
        .json({ message: "No active interview reservation.", code: "NO_RESERVATION" });
    }

    const panelSeats = application.interviewPrep?.panel?.seats || [];
    const N = panelSeats.length;
    const idx = Math.round(Number(seatIndex));
    if (!Number.isInteger(idx) || idx < 1 || idx >= N) {
      return res.status(400).json({ message: "Invalid panel seat." });
    }

    // Cost guard: cap total mints per reservation (seat 0 already counts as 1).
    // Allow up to N + 1 to tolerate one reconnect retry; beyond that we refuse.
    const guard = await UserModel.updateOne(
      {
        _id: user._id,
        "liveInterview.activeReservation.reservationId": reservationId,
        "liveInterview.activeReservation.segmentsMinted": { $lt: N + 1 },
      },
      { $inc: { "liveInterview.activeReservation.segmentsMinted": 1 } }
    );
    if (guard.modifiedCount === 0) {
      return res
        .status(409)
        .json({ message: "Interview segment limit reached.", code: "SEGMENT_LIMIT" });
    }

    const reservedSec = ar.reservedSec || 0;
    // wrapUp isn't persisted on the reservation; assume on (the default). It only
    // affects the LAST seat's split, which is the seat that delivers the closing.
    const budgets = panelSegmentBudgets(reservedSec, N, true);
    const seg = budgets[idx];
    const seat = panelSeats[idx];

    const { jobMeta, fit } = panelInputsFromApplication(application);
    const candidateContext = await buildInterviewCandidateContext(application, {
      userId: req.user.id,
      applicationId: application._id,
    });
    const ALLOWED_STYLES = ["balanced", "screening", "technical", "behavioral"];
    const safeStyle = ALLOWED_STYLES.includes(style) ? style : "balanced";
    const ALLOWED_CHALLENGE = ["gentle", "realistic", "tough"];
    const safeChallenge = ALLOWED_CHALLENGE.includes(challenge) ? challenge : "realistic";

    const instructions = aiService.buildRealtimeInstructions(
      candidateContext,
      jobMeta,
      Array.isArray(questionSpine) ? questionSpine : [],
      Math.max(1, Math.round(seg.mainSec / 60)),
      {
        timeOfDay: typeof timeOfDay === "string" ? timeOfDay : "",
        candidateName: typeof candidateName === "string" ? candidateName.slice(0, 40) : "",
        fit,
        style: safeStyle,
        challenge: safeChallenge,
        panel: panelSeats,
        panelMode: "multi-voice",
        segment: { index: idx, isFirst: false, isLast: idx === N - 1 },
      }
    );

    const model = subscription.modelForUser(user);
    const session = await realtime.mintRealtimeSession({
      instructions,
      voice: seat.voice,
      model,
      maxSessionSec: seg.maxSessionSec,
      // Non-final seats hand off to the next interviewer via the tool.
      enableHandoff: idx < N - 1,
    });

    res.status(200).json({
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt,
      model: session.model,
      voice: session.voice,
      mainSec: seg.mainSec,
      graceSec: seg.graceSec,
      maxSessionSec: session.maxSessionSec,
      seatIndex: idx,
      name: seat.name,
      role: seat.role,
    });
  } catch (error) {
    console.error("[InterviewPrep] mintRealtimeSegment failed:", error.message);
    if (
      error.code === "REALTIME_UNAVAILABLE" ||
      error.code === "AI_UNAVAILABLE" ||
      error.name === "AIUnavailableError"
    ) {
      return res
        .status(503)
        .json({ message: "The next interviewer is temporarily unavailable.", code: "REALTIME_UNAVAILABLE" });
    }
    res.status(500).json({ message: "Failed to start the next interviewer" });
  }
};

/**
 * Assess a completed CONVERSATIONAL interview from its transcript and persist the
 * result as this prep's last session. Grounded in the candidate's CV + the job.
 * Replaces the old self-rating for conversational/realtime runs. Content-only
 * (a transcript can't judge vocal delivery).
 *
 * Also reconciles the live-interview minutes reserved by createRealtimeSession:
 * the unused remainder of the reservation is refunded based on the client-reported
 * (and clamped) duration. Done first, so minutes reconcile even if AI grading fails.
 */
exports.assessInterview = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { transcript, durationSec, plannedSec, reservationId, interviewerSeatIndex } =
      req.body || {};

    const application = await Application.findById(id).populate("jobId");
    if (!application) return res.status(404).json({ message: "Application not found" });
    if (application.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "User not authorized" });
    }

    // ---- Reconcile the reserved minutes (reserve-then-reconcile) ----
    // Only when this came from a realtime session (reservationId present). The
    // updateOne is guarded on the reservation id, so a double-submit can't refund
    // twice. usedSec is clamped to what we reserved — the trust boundary: the
    // client can only reduce the bill, never exceed the reservation.
    // Which source funded this session — "free" (lifetime taste) vs "paid"
    // (subscription / top-up / Practice Pass minutes). Captured from the
    // reservation so the scorecard gate below can tell a free taste from a paid
    // Practice Pass run even though both are "free" tier. null = no live
    // reservation matched (e.g. a re-run after the reservation was cleared).
    let reservationMode = null;
    let sessionUsedSec = null; // billed seconds (clamped to the reservation)
    if (reservationId) {
      const UserModel = require("../models/User");
      const Transaction = require("../models/Transaction");
      const u = await UserModel.findById(req.user.id);
      const ar = u?.liveInterview?.activeReservation;
      if (ar && ar.reservationId === reservationId) {
        reservationMode = ar.mode || "paid";
        const reservedSec = ar.reservedSec || 0;
        const usedSec = Math.max(0, Math.min(Math.round(Number(durationSec) || 0), reservedSec));
        sessionUsedSec = usedSec;
        const refund = reservedSec - usedSec;
        const refundInc =
          ar.mode === "free"
            ? { $inc: { "liveInterview.freeTasteUsedSec": -refund } }
            : { $inc: { "liveInterview.secondsRemaining": refund } };
        const recon = await UserModel.updateOne(
          { _id: u._id, "liveInterview.activeReservation.reservationId": reservationId },
          { ...refundInc, $set: { "liveInterview.activeReservation": {} } }
        );
        if (recon.modifiedCount === 1) {
          // Usage record for analytics only — never let it break the score.
          try {
            const eff = require("../services/subscription.service").getEffectiveTier(u);
            await Transaction.create({
              userId: u._id,
              amount: 0, // money/credits don't move here
              type: "usage",
              description: `Live interview ${usedSec}s (${eff})`,
              status: "completed",
            });
          } catch (txErr) {
            console.error("[InterviewPrep] usage transaction skipped:", txErr.message);
          }
        }
      }
    }

    // Scorecard gate. A FREE-TASTE session is practice-only — no AI scorecard (the
    // grading call is the costliest gpt-4o pass of the whole session) — and that
    // locked scorecard IS the upsell. A session funded by PURCHASED minutes
    // (subscription / top-up / ₦600 Practice Pass) always gets the scorecard, even
    // for a free-tier user. Key off the reservation mode captured above; when no
    // reservation matched (a re-run after it was cleared), fall back to the
    // effective tier — paid subscribers keep their score; a free-tier user re-run
    // stays locked. Minutes were already reconciled, so the taste is still metered.
    let scorecardLocked;
    if (reservationMode) {
      scorecardLocked = reservationMode === "free";
    } else {
      const subscription = require("../services/subscription.service");
      const UserModel = require("../models/User");
      const u3 = await UserModel.findById(req.user.id);
      scorecardLocked = !u3 || subscription.getEffectiveTier(u3) === "free";
    }
    if (scorecardLocked) {
      return res.status(200).json({
        assessment: null,
        analysisLocked: true,
        code: "ANALYSIS_LOCKED",
        message: "Upgrade to a paid plan to unlock your full AI interview scorecard.",
      });
    }

    // Minimum-length gate. The AI grading call is the costliest part of a session,
    // so we only run it once the candidate has done a substantial interview — this
    // stops "End & review" being tapped repeatedly on near-empty sessions to burn
    // credits. Minutes were already reconciled above (time used is still charged);
    // we just decline the expensive score. Uses the billed (clamped) duration when
    // a reservation matched, else the client-reported duration as a floor.
    const { MIN_REVIEW_SEC } = require("../config/catalog");
    const reviewSec =
      sessionUsedSec != null ? sessionUsedSec : Math.max(0, Math.round(Number(durationSec) || 0));
    if (reviewSec < MIN_REVIEW_SEC) {
      return res.status(200).json({
        assessment: null,
        tooShort: true,
        code: "REVIEW_TOO_SHORT",
        minSeconds: MIN_REVIEW_SEC,
        usedSeconds: reviewSec,
        message: `A scored review needs at least ${Math.round(
          MIN_REVIEW_SEC / 60
        )} minutes of interview — the minutes you used have been counted.`,
      });
    }

    const aiService = require("../services/ai.service");
    const { buildInterviewCandidateContext } = require("./analysis.controller");

    const candidateContext = await buildInterviewCandidateContext(application, {
      userId: req.user.id,
      applicationId: application._id,
    });
    const jobMeta = {
      jobTitle: application.jobTitle || application.jobId?.title || "",
      company: application.jobCompany || application.jobId?.company || "",
    };

    const turns = Array.isArray(transcript) ? transcript : [];
    const assessment = await aiService.assessInterview(
      turns,
      candidateContext,
      jobMeta,
      { userId: req.user.id, applicationId: application._id }
    );

    // The questions the interviewer actually asked (the interviewer's turns) — so
    // the user can see what they were asked after the interview.
    assessment.questionsAsked = turns
      .filter((t) => t && t.role === "interviewer" && typeof t.text === "string" && t.text.trim())
      .map((t) => t.text.trim())
      .slice(0, 30);

    // Persist as the prep's last session + push the desensitization-trend entry,
    // so doing a conversational interview updates readiness/history automatically.
    application.interviewPrep = application.interviewPrep || {};
    const completedAt = new Date();
    application.interviewPrep.lastInterviewSession = {
      completedAt,
      confidence: assessment.readiness,
      score: assessment.overallScore,
      durationSec: Number.isFinite(durationSec) ? Math.round(durationSec) : undefined,
      plannedSec: Number.isFinite(plannedSec) ? Math.round(plannedSec) : undefined,
      flagged: [],
      assessment,
    };
    const history = Array.isArray(application.interviewPrep.interviewHistory)
      ? application.interviewPrep.interviewHistory
      : [];
    history.push({ completedAt, confidence: assessment.readiness, score: assessment.overallScore });
    application.interviewPrep.interviewHistory = history.slice(-10);

    // Readiness: a real interview is evidence about every prepared question. Raise
    // (never lower) each question's confidence toward the assessment band, so a
    // strong conversational interview visibly moves the readiness ring.
    const RANK = { needs_work: 1, almost: 2, ready: 3 };
    const band = assessment.readiness;
    if (RANK[band] && Array.isArray(application.interviewPrep.jobQuestions)) {
      application.interviewPrep.jobQuestions.forEach((q) => {
        if ((RANK[q.confidence] || 0) < RANK[band]) q.confidence = band;
      });
      application.markModified("interviewPrep.jobQuestions");
    }

    application.markModified("interviewPrep.lastInterviewSession");
    application.markModified("interviewPrep.interviewHistory");
    await application.save();

    // Interview LOOP round (pick-a-role) — persisted in an ISOLATED, guarded write
    // AFTER the core score save, with its own atomic ops, so any problem here can
    // NEVER block the score itself (the response still returns 200). Upsert by
    // seat: drop the old round for this seat, then add the new one.
    let roundsOut = (application.interviewPrep.rounds || []).map((r) =>
      typeof r.toObject === "function" ? r.toObject() : r
    );
    try {
      const seatIdx = Number(interviewerSeatIndex);
      const seats = application.interviewPrep.panel?.seats || [];
      if (Number.isInteger(seatIdx) && seatIdx >= 0 && seatIdx < seats.length) {
        const seat = seats[seatIdx];
        const round = {
          seatIndex: seatIdx,
          name: seat.name,
          role: seat.role,
          completedAt,
          score: assessment.overallScore,
          readiness: assessment.readiness,
          durationSec: Number.isFinite(durationSec) ? Math.round(durationSec) : undefined,
          // Own deep copy so we never share a reference with lastInterviewSession.
          assessment: JSON.parse(JSON.stringify(assessment)),
        };
        await Application.updateOne(
          { _id: application._id },
          { $pull: { "interviewPrep.rounds": { seatIndex: seatIdx } } }
        );
        await Application.updateOne(
          { _id: application._id },
          { $push: { "interviewPrep.rounds": round } }
        );
        const fresh = await Application.findById(application._id)
          .select("interviewPrep.rounds")
          .lean();
        roundsOut = fresh?.interviewPrep?.rounds || roundsOut;
      }
    } catch (roundErr) {
      console.error("[InterviewPrep] loop round persist skipped:", roundErr.message);
    }

    res.status(200).json({
      assessment,
      lastInterviewSession: application.interviewPrep.lastInterviewSession,
      rounds: roundsOut,
    });
  } catch (error) {
    // Log name + code + message so a recurring failure (e.g. Gemini quota/rate
    // limit vs a save error) is diagnosable from the server logs.
    console.error(
      "[InterviewPrep] assessInterview failed:",
      error.name,
      error.code || error.status || "",
      error.message
    );
    const msg = String(error.message || "").toLowerCase();
    const isRateLimited =
      error.status === 429 ||
      error.code === 429 ||
      /quota|rate limit|too many requests|resource_exhausted|429/.test(msg);
    if (error.name === "AIUnavailableError" || error.code === "AI_UNAVAILABLE" || isRateLimited) {
      return res.status(503).json({
        message: isRateLimited
          ? "The interview assessor is busy (AI rate limit) — wait a moment and re-run."
          : "The interview assessor is temporarily unavailable.",
        code: "AI_UNAVAILABLE",
      });
    }
    res.status(500).json({ message: "Failed to assess the interview" });
  }
};

/**
 * Grade a user's delivery of one of their Story Bank stories. The story's own
 * STAR text is the reference ("ideal") answer — we're scoring how well the user
 * delivered their prepared story, not inventing a new ideal. Charges 1 credit,
 * logs a transaction, and auto-sets the story's confidence from the score.
 * Works for both Application and CV-only Draft prep (via loadPrepDoc), so it
 * doesn't need job/candidate context.
 */
exports.gradeStoryAnswer = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { storyId, questionText, answerText } = req.body || {};
    if (typeof storyId !== "string" || !storyId.trim()) {
      return res.status(400).json({ message: "storyId is required" });
    }
    if (!answerText || typeof answerText !== "string" || !answerText.trim()) {
      return res.status(400).json({ message: "answerText is required" });
    }

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    const stories = Array.isArray(doc.interviewPrep?.stories) ? doc.interviewPrep.stories : [];
    const story = stories.find((s) => s.id === storyId);
    if (!story) return res.status(404).json({ message: "Story not found on this prep" });

    const User = require("../models/User");
    const Transaction = require("../models/Transaction");
    const aiService = require("../services/ai.service");
    const subscription = require("../services/subscription.service");

    const GRADE_COST = (await settingsService.getCreditCosts()).GRADE_STORY;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    // Paid-only route (requireTier); now also spends credits (tier allowance first).
    if (subscription.availableCredits(user) < GRADE_COST) {
      return res.status(403).json({
        message: "Insufficient credits to grade response. Buy credits or watch an ad to earn more.",
        code: "INSUFFICIENT_CREDITS",
      });
    }

    const starText = [story.situation, story.task, story.action, story.result]
      .filter((p) => typeof p === "string" && p.trim().length > 0)
      .join("\n\n");
    const prompt =
      (typeof questionText === "string" && questionText.trim()) ||
      story.title ||
      "Tell me about this experience.";

    // Grade the delivery against the story's own STAR. No job/candidate context
    // needed — the story was already grounded + fact-checked at generation.
    const aiResult = await aiService.gradeInterviewAnswer(prompt, answerText, starText, "", null, {
      userId: req.user.id,
    });

    // Charge only after the AI call succeeds (or skip for an active paid tier).
    const charge = await subscription.chargeOrSkip(user, GRADE_COST, {
      type: "usage",
      description: `AI grade story: "${(story.title || prompt).substring(0, 40)}..."`,
    });
    if (charge.insufficient) {
      return res.status(403).json({
        message: "Insufficient credits to grade response. Watch an ad to earn credits.",
        code: "INSUFFICIENT_CREDITS",
      });
    }

    const score = Math.max(0, Math.min(100, Math.round(Number(aiResult.score) || 0)));
    let autoConfidence = "needs_work";
    if (score > 75) autoConfidence = "ready";
    else if (score > 45) autoConfidence = "almost";

    story.confidence = autoConfidence;
    doc.markModified("interviewPrep.stories");
    await doc.save();

    res.json({
      score,
      overallFeedback: aiResult.overallFeedback,
      starBreakdown: aiResult.starBreakdown,
      refinedAnswer: aiResult.refinedAnswer,
      confidence: autoConfidence,
      remainingCredits: subscription.availableCredits(user),
    });
  } catch (error) {
    console.error("[InterviewPrep] gradeStoryAnswer failed:", error.message);
    res.status(500).json({ message: "Failed to grade story response" });
  }
};

/**
 * Synthesize speech for Interview Mode (the AI interviewer's voice). Returns an
 * mp3 stream from the configured premium provider; 503 TTS_UNAVAILABLE when no
 * provider key is set, so the client falls back to the browser's built-in voice.
 */
exports.synthesizeTts = async (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ message: "text is required" });
    }
    const tts = require("../services/tts.service");
    if (!(await tts.isConfigured())) {
      return res.status(503).json({ message: "Voice is not configured", code: "TTS_UNAVAILABLE" });
    }
    const audio = await tts.synthesize(text);
    res.set("Content-Type", "audio/mpeg");
    res.set("Cache-Control", "private, max-age=86400");
    return res.send(audio);
  } catch (error) {
    console.error("[InterviewPrep] synthesizeTts failed:", error.message);
    return res.status(503).json({ message: "Failed to synthesize speech", code: "TTS_UNAVAILABLE" });
  }
};

/**
 * Save the result of an Interview Mode session (self-assessed). Overwrites any
 * previous one. `flaggedIndices` are jobQuestions the user wants to work on.
 */
exports.saveInterviewSession = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { confidence, score, durationSec, plannedSec, flaggedIndices } = req.body || {};

    const { doc, unauthorized, notFound } = await loadPrepDoc(
      id,
      req.user.id,
      "userId interviewPrep"
    );
    if (unauthorized) return res.status(401).json({ message: "User not authorized" });
    if (notFound) return res.status(404).json({ message: "Interview prep not found" });

    doc.interviewPrep = doc.interviewPrep || {};
    const questions = Array.isArray(doc.interviewPrep.jobQuestions)
      ? doc.interviewPrep.jobQuestions
      : [];
    const flagged = (Array.isArray(flaggedIndices) ? flaggedIndices : [])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < questions.length)
      .map((i) => ({ index: i, question: questions[i].question }));

    const cleanConfidence = ["needs_work", "almost", "ready"].includes(confidence)
      ? confidence
      : undefined;
    const cleanScore = Number.isFinite(score)
      ? Math.max(0, Math.min(100, Math.round(score)))
      : undefined;
    const completedAt = new Date();

    doc.interviewPrep.lastInterviewSession = {
      completedAt,
      confidence: cleanConfidence,
      score: cleanScore,
      durationSec: Number.isFinite(durationSec) ? Math.round(durationSec) : undefined,
      plannedSec: Number.isFinite(plannedSec) ? Math.round(plannedSec) : undefined,
      flagged,
    };

    // Append to the rolling history (desensitization trend), keeping the last 10.
    const history = Array.isArray(doc.interviewPrep.interviewHistory)
      ? doc.interviewPrep.interviewHistory
      : [];
    history.push({ completedAt, confidence: cleanConfidence, score: cleanScore });
    doc.interviewPrep.interviewHistory = history.slice(-10);

    doc.markModified("interviewPrep.lastInterviewSession");
    doc.markModified("interviewPrep.interviewHistory");
    await doc.save();

    res.json({
      lastInterviewSession: doc.interviewPrep.lastInterviewSession,
      interviewHistory: doc.interviewPrep.interviewHistory,
    });
  } catch (error) {
    console.error("[InterviewPrep] saveInterviewSession failed:", error.message);
    res.status(500).json({ message: "Failed to save interview session" });
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
