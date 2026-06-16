const crypto = require("crypto");
const Application = require("../models/Application");
const DraftCV = require("../models/DraftCV");

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
    const { buildInterviewCandidateContext } = require("./analysis.controller");

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const GRADE_COST = 1;
    if (user.credits < GRADE_COST) {
      return res.status(403).json({
        message: "Insufficient credits to grade response. Watch an ad to earn credits.",
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

    // Deduct credit atomically — guard on the balance inside the update so two
    // concurrent AI actions can't both read the old balance and overspend (or
    // drive credits negative). modifiedCount === 0 means the balance dropped
    // below the cost between the pre-check and here.
    const decResult = await User.updateOne(
      { _id: user._id, credits: { $gte: GRADE_COST } },
      { $inc: { credits: -GRADE_COST } }
    );
    if (decResult.modifiedCount === 0) {
      return res.status(403).json({
        message: "Insufficient credits to grade response. Watch an ad to earn credits.",
        code: "INSUFFICIENT_CREDITS",
      });
    }
    user.credits -= GRADE_COST;

    // Record Transaction
    await Transaction.create({
      userId: user._id,
      amount: -GRADE_COST,
      type: "usage",
      description: `AI grade mock answer: "${questionText.substring(0, 40)}..."`,
      status: "completed",
    });

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
      remainingCredits: user.credits,
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

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const FOLLOWUP_COST = 1;
    if (user.credits < FOLLOWUP_COST) {
      return res.status(403).json({
        message: "Insufficient credits for a follow-up. Watch an ad to earn credits.",
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
      return res.status(200).json({ followUp: "", remainingCredits: user.credits });
    }

    // Atomic, balance-guarded deduction (same pattern as gradeAnswer).
    const decResult = await User.updateOne(
      { _id: user._id, credits: { $gte: FOLLOWUP_COST } },
      { $inc: { credits: -FOLLOWUP_COST } }
    );
    if (decResult.modifiedCount === 0) {
      return res.status(403).json({
        message: "Insufficient credits for a follow-up. Watch an ad to earn credits.",
        code: "INSUFFICIENT_CREDITS",
      });
    }
    user.credits -= FOLLOWUP_COST;

    await Transaction.create({
      userId: user._id,
      amount: -FOLLOWUP_COST,
      type: "usage",
      description: "AI interview follow-up question",
      status: "completed",
    });

    res.status(200).json({ followUp: aiResult.followUp, remainingCredits: user.credits });
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
 * FREE during testing — no credits charged. When realtime becomes a paid
 * (Plus-tier) feature, add the tier gate to the route and the atomic charge
 * here (mirror generateFollowUp's deduction). SECURITY: never log the secret.
 */
exports.createRealtimeSession = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { questionSpine, timeOfDay, candidateName, voice, style } = req.body || {};

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

    const maxSessionSec = Number(process.env.REALTIME_MAX_SESSION_SEC) || 360;
    const ALLOWED_STYLES = ["balanced", "screening", "technical", "behavioral"];
    const instructions = aiService.buildRealtimeInstructions(
      candidateContext,
      jobMeta,
      Array.isArray(questionSpine) ? questionSpine : [],
      Math.round(maxSessionSec / 60),
      {
        timeOfDay: typeof timeOfDay === "string" ? timeOfDay : "",
        candidateName: typeof candidateName === "string" ? candidateName.slice(0, 40) : "",
        fit,
        style: ALLOWED_STYLES.includes(style) ? style : "balanced",
      }
    );

    // NOTE: when realtime becomes a paid Plus-tier feature, charge here — mirror
    // generateFollowUp: atomic, balance-guarded User.updateOne($inc) + Transaction.
    // Free during testing.

    // voice is validated against the allowlist inside the service.
    const session = await realtime.mintRealtimeSession({ instructions, voice });

    res.status(200).json({
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt,
      model: session.model,
      voice: session.voice,
      maxSessionSec: session.maxSessionSec,
      // Grace window (seconds) the client adds AFTER the main time runs out, so
      // the interviewer can verbally wrap up + run the closing instead of a hard cut.
      graceSec: Number(process.env.REALTIME_GRACE_SEC) || 90,
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
 * Assess a completed CONVERSATIONAL interview from its transcript and persist the
 * result as this prep's last session. Grounded in the candidate's CV + the job.
 * Replaces the old self-rating for conversational/realtime runs. Content-only
 * (a transcript can't judge vocal delivery).
 *
 * FREE during testing — no credits charged (future Plus charge site here).
 */
exports.assessInterview = async (req, res) => {
  try {
    const { applicationId: id } = req.params;
    const { transcript, durationSec, plannedSec } = req.body || {};

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

    res.status(200).json({
      assessment,
      lastInterviewSession: application.interviewPrep.lastInterviewSession,
    });
  } catch (error) {
    console.error("[InterviewPrep] assessInterview failed:", error.message);
    if (error.name === "AIUnavailableError" || error.code === "AI_UNAVAILABLE") {
      return res
        .status(503)
        .json({ message: "The interview assessor is temporarily unavailable.", code: "AI_UNAVAILABLE" });
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

    const GRADE_COST = 1;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.credits < GRADE_COST) {
      return res.status(403).json({
        message: "Insufficient credits to grade response. Watch an ad to earn credits.",
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

    // Charge only after the AI call succeeds; guard the balance atomically.
    const decResult = await User.updateOne(
      { _id: user._id, credits: { $gte: GRADE_COST } },
      { $inc: { credits: -GRADE_COST } }
    );
    if (decResult.modifiedCount === 0) {
      return res.status(403).json({
        message: "Insufficient credits to grade response. Watch an ad to earn credits.",
        code: "INSUFFICIENT_CREDITS",
      });
    }
    user.credits -= GRADE_COST;

    await Transaction.create({
      userId: user._id,
      amount: -GRADE_COST,
      type: "usage",
      description: `AI grade story: "${(story.title || prompt).substring(0, 40)}..."`,
      status: "completed",
    });

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
      remainingCredits: user.credits,
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
