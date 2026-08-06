const mongoose = require("mongoose");
const DraftCV = require("../models/DraftCV");
const User = require("../models/User");
const aiService = require("../services/ai.service");
const subscription = require("../services/subscription.service");
const settingsService = require("../services/settings.service");
const modelSelection = require("../services/modelSelection.service");
const atsCoach = require("../services/atsCoach.service");
const langService = require("../services/language.service");
const scoringEngine = require("../services/scoringEngine.service");
const { scanSections } = require("../services/sectionScan.service");
const { isPaidActive } = require("../services/subscription.service");
const { resolveDraftBrief, buildBriefForJd, briefHashFor } = require("./coach.controller");
const { buildMarkdownFromDraft, checkCredits } = require("./analysis.controller");

// Shared input floor for anything that takes a job. Mirrors the frontend's capture
// form (a title plus a JD substantial enough to actually extract from).
const MIN_JD_LENGTH = 25;

// Validate a { jobTitle, jobDescription } pair. Returns an error string, or null.
const validateJob = (title, description) => {
  if (!title) return "jobTitle is required";
  if (!description) return "jobDescription is required";
  if (description.length < MIN_JD_LENGTH) {
    return `jobDescription must be at least ${MIN_JD_LENGTH} characters`;
  }
  return null;
};

// The CONTENT a tailored copy inherits. Everything absent from this list is
// deliberately NOT copied — the copy starts with a clean conversation (coachChats),
// no generation caches (genState, skillsGenCache), no prep/export history
// (interviewPrep, exportCount, isComplete) and no application link
// (sourceApplicationId), all of which belong to the SOURCE, not the tailored fork.
const CLONED_CONTENT_FIELDS = [
  "personalInfo",
  "professionalSummary",
  "experience",
  "projects",
  "education",
  "certifications",
  "skills",
];

// @desc    Build Aria's Role Brief from raw JD text, with NO draft attached — so the
//          user can check (and correct) her read of the job BEFORE any tailored copy
//          exists. Nothing is persisted and nothing is charged, matching /coach/brief:
//          aiService.buildRoleBrief runs through withExtractionCache, so a re-preview
//          of the same JD costs nothing.
// @route   POST /api/studio/brief-preview
// @access  Private
const briefPreview = async (req, res) => {
  const { jobTitle, jobDescription, model } = req.body || {};

  const title = (jobTitle || "").trim();
  const description = (jobDescription || "").trim();

  const invalid = validateJob(title, description);
  if (invalid) return res.status(400).json({ message: invalid });

  try {
    let modelId;
    if (model) {
      // A stale/hidden model pick must never block a CV create — same policy as
      // modelSelection.resolveForAction ("never hard-fail a chat over a stale pick").
      // Fall back to DEFAULT_MODEL and just log it; the client never learns its pick
      // was rejected, which is fine since Studio re-resolves the model on every turn.
      let gate = await modelSelection.gateModel(model);
      if (!gate.ok) {
        console.warn(`Studio brief-preview: model "${model}" not exposed, using default`);
        gate = await modelSelection.gateModel(modelSelection.DEFAULT_MODEL);
      }
      modelId = gate.ok ? gate.modelId : modelSelection.DEFAULT_MODEL;
    }
    const { brief } = await buildBriefForJd(description, title, {
      userId: req.user.id,
      operation: "studioBriefPreview",
      modelId,
      lang: req.lang,
    });
    return res.json({ brief });
  } catch (error) {
    // Non-fatal, same policy as tailor-start: the intake continues without a read
    // rather than dead-ending the user.
    if (error instanceof aiService.AIUnavailableError) {
      console.error("Studio brief-preview: AI unavailable", error);
    } else {
      console.error("Studio Brief Preview Error:", error);
    }
    return res.json({ brief: null });
  }
};

// @desc    Draft a realistic, generic job posting from just a job title — for a user
//          who knows the role they want but has no real posting to paste. Runs BEFORE
//          a tailor session exists (still on the capture form), so there is no draft
//          to attach it to yet. Charges DRAFT_JD, but only after a non-empty draft
//          comes back (the AI's scope guard returns "" for non-job-title input, and
//          that must not be charged either).
// @route   POST /api/studio/draft-jd
// @access  Private
const draftJd = async (req, res) => {
  const { jobTitle } = req.body || {};
  const title = String(jobTitle || "").trim();

  if (!title || title.length > 120) {
    return res
      .status(400)
      .json({ message: "jobTitle is required and must be under 120 characters" });
  }

  try {
    const user = await User.findById(req.user.id).select("plan subscription credits");
    if (!user) return res.status(404).json({ message: "User not found" });

    // Draft JD ALWAYS runs on the Standard (light) model, whatever the user's gen-model
    // pick is. A generic posting doesn't need a flagship model, and pinning here (a)
    // sidesteps the flagship (Claude) thinking-token truncation that returned 502s and
    // (b) keeps the price predictable at the light DRAFT_JD rate. The client's model
    // pick is intentionally ignored for this action.
    const modelId = modelSelection.DEFAULT_MODEL;
    const tier = "light";
    const cost = await modelSelection.costForAction("DRAFT_JD", tier);

    // PRE-CHECK the balance before spending an AI call the user can't pay for — only
    // when it will actually meter (a paid LIGHT draft is free/unlimited; flagship
    // always meters).
    const willMeter = tier === "flagship" || !subscription.isPaidActive(user);
    if (willMeter && subscription.availableCredits(user) < cost) {
      return res.status(403).json({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits",
        required: cost,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    let result;
    try {
      result = await aiService.draftJobDescription({
        jobTitle: title,
        meta: {
          userId: req.user.id,
          operation: "draftJobDescription",
          modelId,
          lang: req.lang,
        },
      });
    } catch (genErr) {
      if (genErr instanceof aiService.AIUnavailableError) {
        return res
          .status(503)
          .json({ message: "AI is not configured right now. Please try again later." });
      }
      console.error("Studio draft-jd AI error:", genErr.message);
      return res
        .status(502)
        .json({ message: "Couldn't draft a description for that job title. Please try again." });
    }

    const jobDescription = (result || "").trim();
    if (!jobDescription) {
      // Either a genuinely empty model response, or the scope guard rejecting input
      // that isn't a plausible job title — either way, don't charge for it.
      return res
        .status(502)
        .json({ message: "Aria couldn't draft a description for that job title." });
    }

    // Charge only on confirmed success — tier-aware (flagship always meters; light
    // free on an active paid plan).
    const charge = await modelSelection.chargeForModel(user, cost, tier, {
      type: "draft_jd",
      description: "Aria job description draft",
    });
    if (charge.insufficient) {
      return res.status(402).json({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits",
        required: cost,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    return res.json({
      jobDescription,
      cost,
      remainingCredits: subscription.availableCredits(user),
    });
  } catch (error) {
    if (error instanceof aiService.AIUnavailableError) {
      return res
        .status(503)
        .json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Studio Draft JD Error:", error);
    return res.status(500).json({ message: "Failed to draft job description" });
  }
};

// @desc    Start an Aria Studio tailor run: clone a source CV's content into a new
//          draft bound to a target job, then attach its Role Brief. The source draft
//          is never mutated.
//
//          An OPTIONAL `brief` (the one the user already confirmed at the preview step)
//          is persisted as-is with the JD's hash, so the confirmed read — including any
//          correction the user made — is exactly what lands on the copy. Omit it and the
//          brief is built here instead.
// @route   POST /api/studio/tailor-start
// @access  Private
const tailorStart = async (req, res) => {
  const {
    sourceDraftId,
    jobTitle,
    jobDescription,
    brief: confirmedBrief,
    model,
    jdSource,
  } = req.body || {};

  const title = (jobTitle || "").trim();
  const description = (jobDescription || "").trim();

  if (!sourceDraftId) {
    return res.status(400).json({ message: "sourceDraftId is required" });
  }
  if (!mongoose.Types.ObjectId.isValid(sourceDraftId)) {
    return res.status(400).json({ message: "Invalid sourceDraftId format" });
  }
  const invalid = validateJob(title, description);
  if (invalid) return res.status(400).json({ message: invalid });

  // Only a real object is trusted as a pre-built brief; anything else falls through
  // to building one, so a malformed body can't poison the draft.
  const hasConfirmedBrief =
    confirmedBrief && typeof confirmedBrief === "object" && !Array.isArray(confirmedBrief);

  try {
    let modelId;
    if (model) {
      // A stale/hidden model pick must never block a CV create — same policy as
      // modelSelection.resolveForAction ("never hard-fail a chat over a stale pick").
      // Fall back to DEFAULT_MODEL and just log it; the client never learns its pick
      // was rejected, which is fine since Studio re-resolves the model on every turn.
      let gate = await modelSelection.gateModel(model);
      if (!gate.ok) {
        console.warn(`Studio tailor-start: model "${model}" not exposed, using default`);
        gate = await modelSelection.gateModel(modelSelection.DEFAULT_MODEL);
      }
      modelId = gate.ok ? gate.modelId : modelSelection.DEFAULT_MODEL;
    }
    // 1. Load + ownership-check the source (mirrors cv.controller.getDraftById).
    const source = await DraftCV.findById(sourceDraftId);
    if (!source) {
      return res.status(404).json({ message: "Draft not found" });
    }
    if (source.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "Not authorized" });
    }

    // CV agents must hold an active plan to CREATE CVs — same gate as
    // cv.controller.saveDraft's create branch, since this is a create.
    if (req.user.role === "agent" && !isPaidActive(req.user)) {
      return res.status(402).json({
        message: "An active agent plan is required to create CVs.",
        code: "NEED_AGENT_SUB",
      });
    }

    // 2. Clone CONTENT ONLY. _sortIds are copied as-is on purpose: the tailored
    //    copy's entries stay addressable by the same ids the source used, so Aria's
    //    per-entry writers work identically on the fork.
    const src = source.toObject();
    const cloned = {};
    CLONED_CONTENT_FIELDS.forEach((field) => {
      if (src[field] !== undefined) cloned[field] = src[field];
    });

    // A confirmed brief is written straight into targetJob alongside the JD's hash.
    // That makes step 3 a CACHE HIT inside resolveDraftBrief (brief present AND
    // briefHash matches), so the AI is not called a second time and the user's
    // corrected read is what persists.
    const copy = await DraftCV.create({
      ...cloned,
      userId: req.user.id,
      title: `${src.title || "Untitled CV"} — ${title}`,
      source: "scratch",
      studioKind: "tailor", // marks this draft as a Studio session (see DraftCV.studioKind)
      ...(modelId ? { studioModelId: modelId } : {}),
      tailoredFrom: source._id,
      tailoredFromTitle: src.title || "Untitled CV",
      // A tailored copy keeps the SOURCE CV's document language — you are
      // tailoring that CV, not starting a fresh one in your app language.
      outputLang: source.outputLang || langService.newCvLang(req),
      tailoredForJob: { title },
      targetJob: {
        title,
        description,
        source: jdSource === "ai_drafted" ? "ai_drafted" : "pasted",
        ...(hasConfirmedBrief
          ? { brief: confirmedBrief, briefHash: briefHashFor(description) }
          : {}),
      },
    });

    // 3. Resolve the Role Brief on the COPY. With a confirmed brief this returns it
    //    untouched (no AI call); without one it builds and persists brief + briefHash,
    //    so a later /coach/brief is a cache hit either way.
    //    A brief failure must not lose the clone the user just paid attention to —
    //    respond with the draft and a null brief; the frontend can retry via getBrief.
    let brief = null;
    try {
      brief = await resolveDraftBrief(copy, {
        userId: req.user.id,
        operation: "studioTailorStart",
        modelId,
        lang: req.lang,
      });
    } catch (briefError) {
      if (briefError instanceof aiService.AIUnavailableError) {
        console.error("Studio tailor-start: AI unavailable for brief", briefError);
      } else {
        console.error("Studio tailor-start: brief build failed", briefError);
      }
    }

    return res.status(201).json({
      draftId: copy._id,
      title: copy.title,
      brief,
      tailoredFrom: source._id,
      draft: copy,
    });
  } catch (error) {
    console.error("Studio Tailor Start Error:", error);
    return res.status(500).json({ message: "Couldn't start tailoring. Please try again." });
  }
};

// Load a Studio draft the caller owns, or send the right error. Returns the draft,
// or null once it has already responded.
const loadOwnedDraft = async (req, res, draftId) => {
  if (!draftId) {
    res.status(400).json({ message: "draftId is required" });
    return null;
  }
  if (!mongoose.Types.ObjectId.isValid(draftId)) {
    res.status(400).json({ message: "Invalid draftId format" });
    return null;
  }
  const draft = await DraftCV.findById(draftId);
  if (!draft) {
    res.status(404).json({ message: "Draft not found" });
    return null;
  }
  if (draft.userId.toString() !== req.user.id) {
    res.status(401).json({ message: "Not authorized" });
    return null;
  }
  return draft;
};

// The job context both scan and recompute measure against — the confirmed Role Brief
// where there is one, plus whatever cached keyword extraction exists.
const jobDataFor = (draft) => {
  const targetJob = draft.targetJob || {};
  const brief = targetJob.brief?.toObject ? targetJob.brief.toObject() : targetJob.brief;
  return { brief, aiKeywords: targetJob.aiKeywords || [] };
};

// @desc    Full scan: AI fit analysis of the CV against its target job, plus the free
//          deterministic per-section verdicts. Charges ANALYSIS — but only after the
//          AI has actually succeeded.
// @route   POST /api/studio/scan
// @access  Private
const scan = async (req, res) => {
  const { draftId } = req.body || {};

  try {
    const draft = await loadOwnedDraft(req, res, draftId);
    if (!draft) return undefined;

    const jd = (draft.targetJob?.description || "").trim();
    if (!jd) {
      return res.status(400).json({
        message: "This CV has no target job to scan against.",
        code: "NO_TARGET_JOB",
      });
    }

    const user = await User.findById(req.user.id).select("plan subscription credits");
    if (!user) return res.status(404).json({ message: "User not found" });

    // Resolve the session's model (session → draft → user → default), gate it, and price
    // the scan by its TIER (flagship scan costs more). The scan RUNS on this model.
    const { modelId, tier, cost } = await modelSelection.resolveForAction({
      action: "ANALYSIS",
      sessionModelId: req.body?.model,
      draft,
      user,
    });

    // Pre-flight balance check — only when the scan will actually meter (a paid LIGHT
    // scan is free/unlimited; flagship always meters). Does NOT deduct yet.
    const willMeter = tier === "flagship" || !subscription.isPaidActive(user);
    if (willMeter) checkCredits(user, cost);

    // Serialize exactly the way the analysis pipeline does.
    const cvMarkdown = buildMarkdownFromDraft(draft);

    // If this throws, we fall to the catch WITHOUT having deducted anything — the
    // whole point of the check/deduct split. meta.modelId routes it to the selected model.
    const aiResult = await aiService.analyzeProfile(cvMarkdown, jd, {
      userId: req.user.id,
      modelId,
      operation: "studioScan",
      lang: req.lang,
    });

    // AI succeeded — now charge the tier cost (flagship always meters; light free on paid).
    const charge = await modelSelection.chargeForModel(user, cost, tier, {
      type: "studio_scan",
      description: "Studio scan",
    });
    const remainingCredits =
      charge.remainingCredits != null
        ? charge.remainingCredits
        : subscription.availableCredits(user);

    // Free, deterministic, no AI.
    const { sections } = scanSections(draft, jobDataFor(draft));

    // Capture the STARTING point once, on the very first scan of this CV, and never
    // overwrite it — a re-scan after the user has improved things must not quietly
    // reset "before" to the improved number and make the finish card claim no progress.
    const prevScan = draft.studioScan?.toObject
      ? draft.studioScan.toObject()
      : draft.studioScan || {};
    const baseline =
      prevScan.baseline?.fitScore != null
        ? prevScan.baseline
        : {
            fitScore: aiResult.fitScore,
            sections: sections.map((s) => ({ key: s.key, band: s.band, score: s.score })),
            capturedAt: new Date(),
          };

    const snapshot = {
      fitScore: aiResult.fitScore,
      recommendation: aiResult.recommendation,
      scoreBreakdown: aiResult.scoreBreakdown || {},
      matchedSkills: aiResult.matchedSkills || [],
      missingSkills: aiResult.missingSkills || [],
      evidence: aiResult.evidence || [],
      sections,
      baseline,
      jdHash: briefHashFor(jd),
      scannedAt: new Date(),
      recomputedAt: null,
      fromLastFullScan: false,
    };

    draft.studioScan = snapshot;
    await draft.save();

    return res.json({ studioScan: snapshot, remainingCredits });
  } catch (error) {
    if (error?.code === "INSUFFICIENT_CREDITS") {
      return res.status(403).json({
        message: "Insufficient credits",
        code: "INSUFFICIENT_CREDITS",
        required: error.required,
        current: error.current,
      });
    }
    if (error instanceof aiService.AIUnavailableError) {
      return res
        .status(503)
        .json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Studio Scan Error:", error);
    return res.status(502).json({ message: "Couldn't scan this CV. Please try again." });
  }
};

// @desc    Free deterministic re-score after an edit. No AI, no charge: recomputes the
//          fit score and section bands from the rules alone. The AI narrative from the
//          last full scan is KEPT and flagged fromLastFullScan rather than regenerated —
//          fabricating fresh commentary without asking the model would be a lie.
// @route   POST /api/studio/recompute
// @access  Private
const recompute = async (req, res) => {
  const { draftId } = req.body || {};

  try {
    const draft = await loadOwnedDraft(req, res, draftId);
    if (!draft) return undefined;

    const jd = (draft.targetJob?.description || "").trim();
    if (!jd) {
      return res.status(400).json({
        message: "This CV has no target job to score against.",
        code: "NO_TARGET_JOB",
      });
    }

    const jobData = jobDataFor(draft);
    const brief = jobData.brief || {};

    // Map the cached brief into the shape computeFitScore expects. No extraction call —
    // everything here was already paid for by the scan (or the brief preview).
    const candidateData = atsCoach.cvDataToCandidate(draft);
    const scoring = scoringEngine.computeFitScore({
      candidateData,
      jobData: {
        jobTitle: draft.targetJob?.title || brief.role || "",
        jobDescription: jd,
        requiredSkills: brief.mustHaves || [],
        preferredSkills: brief.niceToHaves || [],
        requiredYearsExperience: brief.yearsRequired || 0,
        seniorityLevel: brief.seniority || "",
        requiredEducation: brief.requiredEducation || null,
      },
    });

    const { sections } = scanSections(draft, jobData);

    const prev = draft.studioScan?.toObject ? draft.studioScan.toObject() : draft.studioScan || {};
    const snapshot = {
      ...prev,
      fitScore: scoring.fitScore,
      recommendation: scoring.recommendation,
      scoreBreakdown: scoring.scoreBreakdown,
      matchedSkills: scoring.matchedSkills || [],
      missingSkills: scoring.missingSkills || [],
      // Narrative is NOT regenerated — kept verbatim from the last full scan.
      evidence: prev.evidence || [],
      sections,
      // Baseline is a historical fact — a free re-score must never move it, or the
      // finish card's "before" would creep up to match the "after".
      baseline: prev.baseline,
      jdHash: briefHashFor(jd),
      recomputedAt: new Date(),
      // Only meaningful once there IS an AI narrative sitting behind fresh numbers.
      fromLastFullScan: !!prev.scannedAt,
    };

    draft.studioScan = snapshot;
    await draft.save();

    return res.json({ studioScan: snapshot });
  } catch (error) {
    console.error("Studio Recompute Error:", error);
    return res.status(500).json({ message: "Couldn't re-score this CV. Please try again." });
  }
};

// Prefill a new CV's contact block from the user's profile.
//
// MIRRORS the CV builder's Heading.jsx populateForm — same fields, same name join, and
// the same restraint: only fill what the profile actually has, and leave `address`
// blank because User doesn't store one. Two surfaces disagreeing about what "your
// details" means is exactly the kind of thing users notice and don't trust.
const personalInfoFromUser = (user = {}) => {
  const info = {};
  const nameParts = [user.firstName, user.otherName, user.lastName].filter(Boolean);
  if (nameParts.length) info.fullName = nameParts.join(" ");
  if (user.email) info.email = user.email;
  if (user.phone) info.phone = user.phone;
  if (user.linkedinUrl) info.linkedin = user.linkedinUrl;
  if (user.portfolioUrl) info.website = user.portfolioUrl;
  return info;
};

// @desc    Start an Aria Studio BUILD session: an empty CV with the user's contact
//          details already filled in, optionally aimed at a job from the outset.
//          Unlike tailorStart there's nothing to clone — this is a blank document.
// @route   POST /api/studio/build-start
// @access  Private
const buildStart = async (req, res) => {
  const { jobTitle, jobDescription, model } = req.body || {};
  const title = (jobTitle || "").trim();
  const description = (jobDescription || "").trim();

  // The job is OPTIONAL here (you can build a CV before you have a role in mind), but
  // a half-supplied one is a mistake worth catching rather than silently dropping.
  const hasJob = !!(title || description);
  if (hasJob) {
    const invalid = validateJob(title, description);
    if (invalid) return res.status(400).json({ message: invalid });
  }

  try {
    let modelId;
    if (model) {
      // Same policy as tailorStart above: a stale/hidden model pick falls back to
      // DEFAULT_MODEL rather than blocking the create.
      let gate = await modelSelection.gateModel(model);
      if (!gate.ok) {
        console.warn(`Studio build-start: model "${model}" not exposed, using default`);
        gate = await modelSelection.gateModel(modelSelection.DEFAULT_MODEL);
      }
      modelId = gate.ok ? gate.modelId : modelSelection.DEFAULT_MODEL;
    }
    // Same create gate as tailorStart and cv.controller.saveDraft — this is a create,
    // so an agent without an active plan must not slip through a different door.
    if (req.user.role === "agent" && !isPaidActive(req.user)) {
      return res.status(402).json({
        message: "An active agent plan is required to create CVs.",
        code: "NEED_AGENT_SUB",
      });
    }

    const user = await User.findById(req.user.id).select(
      "firstName otherName lastName email phone linkedinUrl portfolioUrl"
    );
    const personalInfo = personalInfoFromUser(user || {});

    const draft = await DraftCV.create({
      userId: req.user.id,
      title: title ? `CV for ${title}` : "Untitled CV",
      source: "scratch",
      studioKind: "build",
      ...(modelId ? { studioModelId: modelId } : {}),
      outputLang: langService.newCvLang(req),
      personalInfo,
      ...(hasJob ? { targetJob: { title, description } } : {}),
    });

    // Read the job now if we have one, so the build is JD-aware from the first
    // question. Non-fatal, same policy as tailorStart: a brief failure must not cost
    // the user the draft they just created.
    let brief = null;
    if (hasJob) {
      try {
        const built = await buildBriefForJd(description, title, {
          userId: req.user.id,
          operation: "studioBuildStart",
          modelId,
          lang: req.lang,
        });
        brief = built.brief;
        if (brief) {
          draft.targetJob.brief = brief;
          draft.targetJob.briefHash = built.hash;
          await draft.save();
        }
      } catch (briefError) {
        console.error("Studio build-start: brief build failed", briefError);
      }
    }

    return res.status(201).json({
      draftId: draft._id,
      personalInfo: draft.personalInfo,
      brief,
      draft,
    });
  } catch (error) {
    console.error("Studio Build Start Error:", error);
    return res.status(500).json({ message: "Couldn't start your CV. Please try again." });
  }
};

// How many sessions the rail shows. Far past what anyone scrolls, and it bounds the
// response regardless of how many CVs a heavy user accumulates.
const SESSION_LIMIT = 50;

// @desc    The current user's Aria Studio sessions, newest-updated first. A session IS a
//          DraftCV — there is no separate conversation model — so this is a LEAN
//          projection of the few fields the rail renders. Whole drafts (with their
//          transcripts, scans and CV content) are never returned here; the rail would
//          otherwise ship megabytes to draw a list of titles.
// @route   GET /api/studio/sessions
// @access  Private
const sessions = async (req, res) => {
  try {
    const rows = await DraftCV.find(
      { userId: req.user.id, studioKind: { $ne: null } },
      // Projection — nothing here is expensive, and nothing sensitive leaks.
      {
        studioKind: 1,
        title: 1,
        "tailoredForJob.title": 1,
        "targetJob.brief.company": 1,
        tailoredFromTitle: 1,
        "studioScan.fitScore": 1,
        updatedAt: 1,
      }
    )
      .sort({ updatedAt: -1 })
      .limit(SESSION_LIMIT)
      .lean();

    return res.json({
      sessions: (rows || []).map((r) => ({
        _id: r._id,
        kind: r.studioKind,
        title: r.title,
        jobTitle: r.tailoredForJob?.title || "",
        company: r.targetJob?.brief?.company || "",
        sourceTitle: r.tailoredFromTitle || "",
        fitScore: r.studioScan?.fitScore ?? null,
        updatedAt: r.updatedAt,
      })),
    });
  } catch (error) {
    console.error("Studio Sessions Error:", error);
    return res.status(500).json({ message: "Couldn't load your sessions." });
  }
};

module.exports = { tailorStart, buildStart, briefPreview, draftJd, scan, recompute, sessions };
