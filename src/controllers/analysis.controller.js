const crypto = require("crypto");
const Job = require("../models/Job");
const JobSearch = require("../models/JobSearch");
const DraftCV = require("../models/DraftCV");
const Resume = require("../models/Resume");
const Application = require("../models/Application");
const extractionService = require("../services/extraction.service");
const aiService = require("../services/ai.service");
const cvOptimizer = require("../services/cvOptimizer.service");
const metricCapture = require("../services/metricCapture.service");
const subscription = require("../services/subscription.service");
const settingsService = require("../services/settings.service");

// Credit costs are the single source of truth in config/creditCosts.js, resolved
// (with any admin overrides) via settingsService.getCreditCosts(). Each handler
// loads the resolved map into a local `COSTS` before charging — see the
// `const COSTS = await settingsService.getCreditCosts()` lines below. The canonical
// keys (ANALYSIS, GENERATE_CV, …) match what these handlers reference.

/**
 * Helper: Verify the user has sufficient credits BEFORE running expensive AI work.
 * Throws an INSUFFICIENT_CREDITS error if the balance is too low.
 * Does NOT deduct — call deductCredits only after AI work succeeds.
 */
const checkCredits = (user, cost) => {
  // Paid tiers draw from their per-period allowance first, then the wallet —
  // so the gate is the COMBINED available balance, not just the wallet.
  if (subscription.availableCredits(user) >= cost) return;
  const err = new Error("Insufficient credits");
  err.code = "INSUFFICIENT_CREDITS";
  err.required = cost;
  err.current = subscription.availableCredits(user);
  throw err;
};

/**
 * Helper: Deduct credits atomically and return the new combined balance.
 * Call this only after AI work has succeeded so users are never charged
 * for failed or unavailable AI calls. Paid tiers spend their per-period
 * allowance first, then the wallet (see subscription.spendCredits).
 */
const deductCredits = async (user, cost) => {
  const res = await subscription.spendCredits(user, cost, {
    type: "usage",
    description: "AI usage",
  });
  if (res.insufficient) {
    const err = new Error("Insufficient credits");
    err.code = "INSUFFICIENT_CREDITS";
    err.required = cost;
    err.current = res.remainingCredits;
    throw err;
  }
  return res.remainingCredits;
};

/**
 * Helper: Map an error to a JSON response. Returns true if handled.
 * Centralizes credit + AI-availability error handling so each controller
 * doesn't have to duplicate it.
 */
const handleAIError = (res, err) => {
  if (err && err.code === "INSUFFICIENT_CREDITS") {
    res.status(403).json({
      message: "Insufficient credits",
      code: "INSUFFICIENT_CREDITS",
      required: err.required,
      current: err.current,
    });
    return true;
  }
  if (err && err.code === "AI_UNAVAILABLE") {
    res.status(503).json({
      message:
        "AI service is temporarily unavailable. You have not been charged. Please try again later.",
      code: "AI_UNAVAILABLE",
    });
    return true;
  }
  return false;
};

/**
 * Helper: Resolve job description from Job model or JobSearch results.
 * Tailor/bundle applications store a JobSearch _id as jobId, not a Job _id.
 */
const resolveJobDescription = async (application) => {
  // Try Job model first (legacy analysis flow)
  const job = await Job.findById(application.jobId);
  if (job) {
    return { description: job.description, title: job.title, company: job.company, source: "job" };
  }

  // Fall back to JobSearch (tailor/bundle flow)
  const search = await JobSearch.findById(application.jobId);
  if (search) {
    // Find the result that matches this application's job title/company
    const result =
      search.results.find(
        (r) => r.title === application.jobTitle && r.company === application.jobCompany
      ) || search.results[0]; // fallback to first result if no match

    if (result) {
      return {
        description: result.fullDescription || result.snippet || "",
        title: result.title,
        company: result.company,
        source: "jobSearch",
      };
    }
  }

  return null;
};

const stringifyDescription = (description) => {
  if (Array.isArray(description)) return description.filter(Boolean).join("\n");
  return description || "";
};

// The AI can only ground STAR-shaped answers when there is at least one real
// work-history entry with a role AND company. A bare summary or a skills list
// is not enough — without a concrete past role the AI invents one (often by
// reciting the role from the job description as if it were the candidate's
// previous role). Gate generation on this.
const hasGroundableExperience = (context) => {
  if (!context || !Array.isArray(context.experience)) return false;
  return context.experience.some(
    (e) =>
      typeof e?.role === "string" &&
      e.role.trim().length > 0 &&
      typeof e?.company === "string" &&
      e.company.trim().length > 0
  );
};

/**
 * Build the profile block used for interview prep. Prefer the edited/generated
 * DraftCV because it reflects the user's latest ApplyRight version, but only
 * if it has groundable experience — otherwise fall through to the uploaded
 * resume so a half-empty draft doesn't starve the AI of real work history.
 */
const buildInterviewCandidateContext = async (application, meta = {}) => {
  if (application.draftCVId) {
    const draft = await DraftCV.findById(application.draftCVId);
    if (draft) {
      const context = {
        summary: draft.professionalSummary,
        experience: (draft.experience || []).map((e) => ({
          role: e.title,
          company: e.company,
          description: stringifyDescription(e.description),
        })),
        education: (draft.education || []).map((e) => ({
          degree: e.degree,
          school: e.school,
          field: e.field,
          description: stringifyDescription(e.description),
        })),
        projects: (draft.projects || []).map((p) => ({
          title: p.title,
          description: stringifyDescription(p.description),
        })),
        skills: (draft.skills || []).map((s) => s.name).filter(Boolean),
      };
      if (hasGroundableExperience(context)) return context;
    }
  }

  if (!application.resumeId) return null;

  const resume = await Resume.findById(application.resumeId);
  if (!resume?.rawText) return null;

  const extracted = await aiService.extractCandidateData(resume.rawText, meta);
  const context = {
    summary: extracted.summary,
    experience: (extracted.experience || []).map((e) => ({
      role: e.role,
      company: e.company,
      description: stringifyDescription(e.description),
    })),
    education: (extracted.education || []).map((e) => ({
      degree: e.degree,
      school: e.school,
      field: e.field,
      description: stringifyDescription(e.description),
    })),
    projects: (extracted.projects || []).map((p) => ({
      title: p.title,
      description: stringifyDescription(p.description),
    })),
    skills: (extracted.skills || [])
      .map((s) => (typeof s === "string" ? s : s.name))
      .filter(Boolean),
  };

  return hasGroundableExperience(context) ? context : null;
};

const serializeInterviewPrep = (application) => {
  const prep = application.interviewPrep?.toObject
    ? application.interviewPrep.toObject()
    : application.interviewPrep || {};
  return {
    isSaved: !!prep.isSaved,
    savedAt: prep.savedAt,
    skillsWithEvidence: prep.skillsWithEvidence || [],
    jobQuestions: prep.jobQuestions || [],
    questionsToAsk: prep.questionsToAsk || [],
    fabricationWarnings: prep.fabricationWarnings || [],
    stories: prep.stories || [],
    storyFabricationWarnings: prep.storyFabricationWarnings || [],
    lastInterviewSession: prep.lastInterviewSession || null,
    userNotes: prep.userNotes || "",
  };
};

/**
 * POST /analysis/analyze
 *
 * Two modes:
 * - With jobId: Analyze resume vs job (10 credits) → returns fitScore, fitAnalysis, actionPlan
 * - Without jobId: Create from upload (15 credits) → returns draftId
 */
const analyzeFit = async (req, res) => {
  try {
    const { jobId, resumeId, draftCVId } = req.body;
    const userId = req.user._id;
    const user = req.user;
    const COSTS = await settingsService.getCreditCosts();

    if (!resumeId && !draftCVId) {
      return res.status(400).json({ message: "Select a saved CV or upload a resume first." });
    }

    // Resolve the source CV text. Two sources:
    //  - resumeId  → an uploaded Resume, use its rawText
    //  - draftCVId → a CV built in ApplyRight, serialize the draft to markdown
    // Ownership is verified on the saved-CV path so a user can't analyze
    // someone else's draft.
    let resume = null; // only set in upload mode (also reused by create-from-upload)
    let draft = null; // only set in saved-CV mode
    let cvText = "";
    if (draftCVId) {
      draft = await DraftCV.findOne({ _id: draftCVId, userId });
      if (!draft) {
        return res.status(404).json({ message: "Saved CV not found" });
      }
      cvText = buildMarkdownFromDraft(draft);
    } else {
      resume = await Resume.findById(resumeId);
      if (!resume) {
        return res.status(404).json({ message: "Resume not found" });
      }
      cvText = resume.rawText;
    }

    // ── Create from Upload (no job) ──
    if (!jobId) {
      // A saved CV is already a structured draft, so "create from upload" only
      // applies to an uploaded resume.
      if (!resume) {
        return res
          .status(400)
          .json({ message: "Add a job description to analyze a saved CV." });
      }
      checkCredits(user, COSTS.CREATE_FROM_UPLOAD);

      const meta = { userId };
      const extractedData = await aiService.extractResumeProfile(resume.rawText, meta);

      const structuredSkills = await aiService.generateStructuredSkills(
        {
          education: extractedData.education,
          experience: extractedData.experience,
          projects: extractedData.projects,
          targetJob: null,
        },
        { ...meta, model: aiService.resolveTextModel(user) }
      );

      // AI work succeeded — now charge the user
      const remainingCredits = await deductCredits(user, COSTS.CREATE_FROM_UPLOAD);

      // CV-extracted contact info takes priority, user profile is fallback
      const cvContact = extractedData.contactInfo || {};
      const userFullName = user.firstName ? `${user.firstName} ${user.lastName}`.trim() : "";
      const draft = await DraftCV.create({
        userId,
        title: "Uploaded Resume",
        source: "upload",
        personalInfo: {
          fullName: cvContact.fullName || userFullName || "Candidate",
          email: cvContact.email || user.email || "",
          phone: cvContact.phone || user.phone || "",
          linkedin: cvContact.linkedin || user.linkedinUrl || "",
          website: cvContact.website || user.portfolioUrl || "",
          address: cvContact.address || user.location || "",
        },
        professionalSummary: extractedData.summary || "",
        experience:
          extractedData.experience?.map((e) => ({
            title: e.role,
            company: e.company,
            startDate: e.startDate,
            endDate: e.endDate,
            description: Array.isArray(e.description)
              ? e.description.map((d) => `• ${d}`).join("\n")
              : e.description || "",
          })) || [],
        education:
          extractedData.education?.map((e) => ({
            degree: e.degree,
            school: e.school,
            field: e.field,
            graduationDate: e.date,
          })) || [],
        projects:
          extractedData.projects?.map((p) => ({
            title: p.title,
            link: p.link,
            description: Array.isArray(p.description)
              ? p.description.map((d) => `• ${d}`).join("\n")
              : p.description || "",
          })) || [],
        skills:
          structuredSkills && structuredSkills.length > 0
            ? structuredSkills.map((s) => ({ ...s, isAutoGenerated: true }))
            : (extractedData.skills || []).map((s) => ({
                name: s,
                category: "Uncategorized",
                isAutoGenerated: false,
              })),
        isComplete: true,
      });

      return res.status(200).json({
        message: "Resume parsed successfully",
        draftId: draft._id,
        fitScore: null,
        fitAnalysis: null,
        remainingCredits,
      });
    }

    // ── Analysis Flow (with job) ──
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    // Pre-flight balance check — does NOT deduct yet
    checkCredits(user, COSTS.ANALYSIS);

    // ── New Pipeline: Extract → Score → Feedback ──
    // applicationId not yet known until upsert below; pass it along after.
    const aiResult = await aiService.analyzeProfile(cvText, job.description, {
      userId,
      model: aiService.resolveTextModel(user),
    });

    // AI succeeded — now charge the user
    const remainingCredits = await deductCredits(user, COSTS.ANALYSIS);

    // Update job metadata from AI detection
    if (aiResult.detectedJobTitle) {
      job.title = aiResult.detectedJobTitle;
    }
    if (aiResult.detectedCompany && aiResult.detectedCompany !== "Unknown Company") {
      job.company = aiResult.detectedCompany;
    }
    await job.save();

    // Map pipeline result to structured format
    const fitScore = aiResult.fitScore;
    const fitAnalysis = {
      overallFeedback: aiResult.overallFeedback || "Analysis complete.",
      recommendation: aiResult.recommendation,
      mode: aiResult.mode,
      evidence: aiResult.evidence || [],
      matchedSkills: aiResult.matchedSkills || [],
      missingSkills: aiResult.missingSkills || [],
      experienceAnalysis: {
        candidateYears: aiResult.experienceAnalysis?.candidateYears ?? 0,
        requiredYears: aiResult.experienceAnalysis?.requiredYears ?? 0,
        match: aiResult.experienceAnalysis?.match ?? true,
        feedback: aiResult.experienceAnalysis?.feedback || "Meets requirements",
      },
      seniorityAnalysis: {
        candidateLevel: aiResult.seniorityAnalysis?.candidateLevel || "mid",
        requiredLevel: aiResult.seniorityAnalysis?.requiredLevel || "mid",
        match: aiResult.seniorityAnalysis?.match ?? true,
        feedback: aiResult.seniorityAnalysis?.feedback || "Aligned with role",
      },
      scoreBreakdown: {
        skillsScore: aiResult.scoreBreakdown?.skillsScore ?? fitScore,
        experienceScore: aiResult.scoreBreakdown?.experienceScore ?? fitScore,
        educationScore: aiResult.scoreBreakdown?.educationScore ?? fitScore,
        seniorityScore: aiResult.scoreBreakdown?.seniorityScore ?? fitScore,
        overallScore: aiResult.scoreBreakdown?.overallScore ?? fitScore,
      },
    };

    const actionPlan = aiResult.actionPlan || [];

    // Save or update Application — analysis fields only. Key the upsert off
    // whichever CV source was used so re-analyzing the same CV+job updates the
    // existing application instead of piling up duplicates.
    const cvRef = draftCVId ? { draftCVId } : { resumeId };
    let application = await Application.findOne({ userId, jobId, ...cvRef });

    if (!application) {
      application = new Application({
        userId,
        jobId,
        ...cvRef,
        fitScore,
        fitAnalysis,
        actionPlan,
      });
    } else {
      application.fitScore = fitScore;
      application.fitAnalysis = fitAnalysis;
      application.actionPlan = actionPlan;
    }

    await application.save();

    res.status(200).json({
      fitScore,
      fitAnalysis,
      actionPlan,
      applicationId: application._id,
      job,
      remainingCredits,
    });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Analysis Error:", {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      message: "Failed to analyze fit. You have not been charged.",
      error: error.message,
    });
  }
};

// Stages used in generationStatus for CV generation. Progress percentages are
// rough — the AI calls (extract + enhance + categorize) dominate latency, so
// we weight progress around when each stage is *complete*.
const CV_STAGES = {
  extracting: { progress: 10, message: "Reading your CV and the role…" },
  scoring: { progress: 30, message: "Ranking your experience by relevance…" },
  enhancing: { progress: 50, message: "Rewriting bullets and weaving in keywords…" },
  categorizing: { progress: 80, message: "Organizing your skills…" },
  assembling: { progress: 95, message: "Putting it all together…" },
  completed: { progress: 100, message: "Done." },
};

/**
 * Set generationStatus on an application doc and persist. Best-effort:
 * never throws back into the pipeline since stage updates aren't worth
 * killing a successful generation over.
 */
const setGenerationStage = async (applicationId, stage, extra = {}) => {
  try {
    const config = CV_STAGES[stage] || {};
    await Application.updateOne(
      { _id: applicationId },
      {
        $set: {
          "generationStatus.stage": stage,
          "generationStatus.progress": config.progress ?? 0,
          "generationStatus.stageMessage": extra.message || config.message || "",
          ...(extra.completedAt ? { "generationStatus.completedAt": extra.completedAt } : {}),
          ...(extra.error ? { "generationStatus.error": extra.error } : {}),
        },
      }
    );
  } catch (e) {
    console.error(`[CV Pipeline] Failed to write stage=${stage}:`, e.message);
  }
};

/**
 * Async CV generation pipeline. Runs after the controller returns 202.
 *
 * Each stage updates application.generationStatus so the frontend can poll
 * GET /applications/:id and render a progress bar. On error, stage becomes
 * "failed" and the user is NOT charged. On success, credits are deducted at
 * the end (atomicity is best-effort: if the deduct fails, the user got the
 * artifact for free — preferable to charging for nothing).
 *
 * `chargeOnSuccess: false` — used by the bundle pipeline so the parent owns
 * credit accounting across multiple stages. When false this function does
 * the full pipeline but skips the credit deduction; caller must charge.
 *
 * Returns `{ draftId, beforeScore, afterScore }` on success.
 */
const runCVGenerationPipeline = async ({
  application,
  resume,
  job,
  user,
  templateId,
  chargeOnSuccess = true,
  providedMetrics = {},
}) => {
  const userId = user._id;
  const applicationId = application._id;
  // tier-based text model (paid/agent → gpt-4o, free → gpt-4o-mini) — flows to
  // every callJSON/callText in this CV-generation pipeline via meta.model.
  const meta = { userId, applicationId, model: aiService.resolveTextModel(user) };
  const COSTS = await settingsService.getCreditCosts();

  try {
    // Stage 1: Extract (parallel)
    await setGenerationStage(applicationId, "extracting");
    const [candidateData, jobData] = await Promise.all([
      aiService.extractCandidateData(resume.rawText, meta),
      aiService.extractJobRequirements(job.description, meta),
    ]);
    if (!jobData.detectedJobTitle) jobData.detectedJobTitle = job.title;
    if (!jobData.detectedCompany) jobData.detectedCompany = job.company;

    // Stage 2: Relevance scoring (deterministic)
    await setGenerationStage(applicationId, "scoring");
    const rankedExperiences = cvOptimizer.rankExperiences(candidateData.experience || [], jobData);
    const rankedProjects = cvOptimizer.rankProjects(candidateData.projects || [], jobData);
    const missingKeywords = cvOptimizer.findKeywordGaps(candidateData.skills || [], jobData);

    // Stage 3: AI content enhancement
    await setGenerationStage(applicationId, "enhancing");
    const aiEnhanced = await aiService.enhanceCVContent({
      candidateData,
      jobData,
      rankedExperiences,
      rankedProjects,
      missingKeywords,
      providedMetrics,
      meta,
    });

    // Stage 4: Merge + categorize skills
    await setGenerationStage(applicationId, "categorizing");
    const allSkillNames = new Set();
    for (const s of candidateData.skills || []) {
      allSkillNames.add(typeof s === "string" ? s : s.name);
    }
    for (const s of aiEnhanced.skills || []) {
      allSkillNames.add(typeof s === "string" ? s : s.name);
    }
    const { compareSkills } = require("../services/skillNormalizer.service");
    const candidateSkillStrings = (candidateData.skills || []).map((s) =>
      typeof s === "string" ? s : s.name
    );
    const allJdSkills = [...(jobData.requiredSkills || []), ...(jobData.preferredSkills || [])];
    const skillComparison = compareSkills(candidateSkillStrings, allJdSkills);
    for (const matched of skillComparison.matched) allSkillNames.add(matched.name);

    // Word-boundary scan instead of plain substring includes(): "Java" in the
    // JD must NOT match "JavaScript" in the resume, but "C++"/"C#"/".NET" DO
    // need to match (a vanilla \b boundary fails on those because + and # are
    // not word chars). The custom boundary below treats anything non-alnum as
    // a separator, so trailing punctuation works correctly.
    const allDescriptionText = [
      ...(candidateData.experience || []).map((e) =>
        Array.isArray(e.description) ? e.description.join(" ") : e.description || ""
      ),
      ...(candidateData.projects || []).map((p) =>
        Array.isArray(p.description) ? p.description.join(" ") : p.description || ""
      ),
    ].join(" ");

    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const skillBoundaryMatch = (skill, text) => {
      const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(skill)}(?=[^A-Za-z0-9]|$)`, "i");
      return re.test(text);
    };

    for (const jdSkill of allJdSkills) {
      const name = typeof jdSkill === "string" ? jdSkill : jdSkill.name;
      if (name && skillBoundaryMatch(name, allDescriptionText)) allSkillNames.add(name);
    }

    const categorized = await aiService.categorizeSkillsList(
      [...allSkillNames],
      jobData.detectedJobTitle || job.title || "",
      meta
    );
    const categorizedSkills = (categorized || []).map((s) => ({
      name: s.name,
      category: s.category,
      isAutoGenerated: true,
    }));

    // Re-score deterministically for the before → after delta
    const { computeFitScore } = require("../services/scoringEngine.service");
    const beforeScore = application.fitScore;
    let afterScore = beforeScore;
    try {
      const rescored = computeFitScore({
        candidateData: { ...candidateData, skills: categorizedSkills.map((s) => s.name) },
        jobData,
      });
      afterScore = rescored.fitScore;
    } catch (scoreErr) {
      console.error("[CV Pipeline] Re-score failed (non-fatal):", scoreErr.message);
    }

    // Stage 5: Assembly
    await setGenerationStage(applicationId, "assembling");
    const draftData = cvOptimizer.assembleDraftCV({
      user,
      aiEnhanced,
      candidateData,
      jobData,
      job,
      categorizedSkills,
    });

    // All AI stages succeeded — charge the user (unless caller is owning the
    // credit accounting, e.g. the bundle pipeline).
    if (chargeOnSuccess) {
      await deductCredits(user, COSTS.GENERATE_CV);
    }

    // Create DraftCV and persist results onto the Application
    const draft = await DraftCV.create({ userId, ...draftData });
    const markdownCV = buildMarkdownFromDraft(draftData);

    const fresh = await Application.findById(applicationId);
    if (fresh) {
      fresh.optimizedCV = markdownCV;
      fresh.draftCVId = draft._id;
      fresh.optimizedFitScore = afterScore;
      fresh.skills = draftData.skills.map((s) => ({
        name: s.name,
        category: s.category,
        isAutoGenerated: true,
      }));
      if (templateId) fresh.templateId = templateId;
      if (fresh.status === "analyzed" || !fresh.status) {
        fresh.status = "assets_generated";
        fresh.statusUpdatedAt = new Date();
      }
      fresh.generationStatus = {
        stage: "completed",
        progress: 100,
        stageMessage: CV_STAGES.completed.message,
        startedAt: fresh.generationStatus?.startedAt,
        completedAt: new Date(),
      };
      await fresh.save();
    }

    console.log(
      `[CV Pipeline] Complete. Draft ID: ${draft._id}. Fit score: ${beforeScore} → ${afterScore}`
    );
    return { draftId: draft._id, beforeScore, afterScore, jobData, candidateData, fresh };
  } catch (err) {
    console.error("[CV Pipeline] Failed:", err.message, err.stack);
    const friendly =
      err.code === "AI_UNAVAILABLE"
        ? "AI service is temporarily unavailable. You have not been charged."
        : "Generation failed. You have not been charged.";
    await setGenerationStage(applicationId, "failed", {
      message: friendly,
      error: friendly,
      completedAt: new Date(),
    });
    // Re-throw so wrapping pipelines (e.g. the bundle) can short-circuit and
    // skip the cover-letter / interview stages instead of running into bad
    // state. The standalone fire-and-forget caller catches at the top level.
    throw err;
  }
};

/**
 * POST /analysis/:id/generate-cv
 *
 * Starts an async CV generation pipeline. Returns 202 immediately so the
 * client can poll /applications/:id for stage progress. Credits are deducted
 * inside the pipeline only after AI work completes successfully.
 */
const generateApplicationCV = async (req, res) => {
  try {
    const { id } = req.params;
    const { templateId, providedMetrics } = req.body || {};
    const userId = req.user._id;
    const user = req.user;
    const COSTS = await settingsService.getCreditCosts();

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    // Concurrent-request guard: refuse a second start while one is in flight.
    const inFlightStages = new Set([
      "extracting",
      "scoring",
      "enhancing",
      "categorizing",
      "assembling",
    ]);
    if (application.generationStatus && inFlightStages.has(application.generationStatus.stage)) {
      return res.status(409).json({
        message: "A CV generation is already in progress for this application.",
        code: "GENERATION_IN_PROGRESS",
        generationStatus: application.generationStatus,
      });
    }

    const [resumeDoc, job] = await Promise.all([
      application.resumeId ? Resume.findById(application.resumeId) : null,
      Job.findById(application.jobId),
    ]);

    // Source CV may be an uploaded Resume (rawText) or a saved DraftCV. The
    // pipeline only reads `resume.rawText`, so for a draft we hand it a
    // lightweight object carrying the markdown-serialized draft.
    let resume = resumeDoc;
    if (!resume && application.draftCVId) {
      const draft = await DraftCV.findById(application.draftCVId);
      if (draft) resume = { rawText: buildMarkdownFromDraft(draft) };
    }

    if (!resume || !job) {
      return res.status(404).json({ message: "Resume or Job not found" });
    }

    // Pre-flight balance check — does NOT deduct yet
    checkCredits(user, COSTS.GENERATE_CV);

    // Mark as started and return 202 so the client can poll.
    application.generationStatus = {
      stage: "extracting",
      progress: CV_STAGES.extracting.progress,
      stageMessage: CV_STAGES.extracting.message,
      startedAt: new Date(),
      completedAt: undefined,
      error: undefined,
    };
    await application.save();

    res.status(202).json({
      applicationId: application._id,
      generationStatus: application.generationStatus,
    });

    // Fire-and-forget: pipeline runs after the response is sent. Errors are
    // caught inside runCVGenerationPipeline and persisted to generationStatus.
    runCVGenerationPipeline({ application, resume, job, user, templateId, providedMetrics }).catch(
      (e) => {
        console.error("[CV Pipeline] Unhandled top-level error:", e);
      }
    );
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("CV Generation Error:", error.message, error.stack);
    res.status(500).json({
      message: "Failed to start CV generation. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * Helper: Convert DraftCV data to markdown for backwards compatibility
 */
const buildMarkdownFromDraft = (draft) => {
  const lines = [];

  // Name
  const name = draft.personalInfo?.fullName || "Candidate";
  lines.push(`# ${name.toUpperCase()}`);
  lines.push("");

  // Summary
  if (draft.professionalSummary) {
    lines.push("## Professional Summary");
    lines.push(draft.professionalSummary);
    lines.push("");
  }

  // Experience
  if (draft.experience && draft.experience.length > 0) {
    lines.push("## Work History");
    for (const exp of draft.experience) {
      lines.push(`### ${exp.title}`);
      lines.push(`${exp.company} | ${exp.startDate} - ${exp.endDate}`);
      if (exp.description) {
        const bullets = exp.description.split("\n").filter((b) => b.trim());
        for (const bullet of bullets) {
          lines.push(bullet.startsWith("•") ? `- ${bullet.slice(1).trim()}` : `- ${bullet}`);
        }
      }
      lines.push("");
    }
  }

  // Skills
  if (draft.skills && draft.skills.length > 0) {
    lines.push("## Skills");
    const byCategory = {};
    for (const skill of draft.skills) {
      const cat = skill.category || "General";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(skill.name);
    }
    for (const [cat, skills] of Object.entries(byCategory)) {
      lines.push(`- **${cat}:** ${skills.join(", ")}`);
    }
    lines.push("");
  }

  // Education
  if (draft.education && draft.education.length > 0) {
    lines.push("## Education");
    for (const edu of draft.education) {
      lines.push(`### ${edu.degree}${edu.field ? ` in ${edu.field}` : ""}`);
      lines.push(`${edu.school}${edu.graduationDate ? ` | ${edu.graduationDate}` : ""}`);
      lines.push("");
    }
  }

  // Certifications & Training (after Education)
  const certs = (draft.certifications || []).filter((c) => c && (c.name || "").trim());
  if (certs.length > 0) {
    lines.push("## Certifications");
    for (const cert of certs) {
      const meta = [cert.issuer, cert.date].filter((p) => (p || "").trim()).join(", ");
      lines.push(`- **${cert.name.trim()}**${meta ? ` — ${meta}` : ""}`);
    }
    lines.push("");
  }

  // Projects
  if (draft.projects && draft.projects.length > 0) {
    lines.push("## Projects");
    for (const proj of draft.projects) {
      lines.push(`### ${proj.title}`);
      if (proj.description) {
        const bullets = proj.description.split("\n").filter((b) => b.trim());
        for (const bullet of bullets) {
          lines.push(bullet.startsWith("•") ? `- ${bullet.slice(1).trim()}` : `- ${bullet}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
};

/**
 * POST /analysis/:id/generate-cover-letter
 *
 * Generate a cover letter for an existing application (5 credits)
 */
const generateApplicationCoverLetter = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const user = req.user;

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    // Resolve resume text
    let resumeText = "";
    const resume = await Resume.findById(application.resumeId);
    if (resume) {
      resumeText = resume.rawText;
    } else {
      // Tailor/bundle apps store a DraftCV _id as resumeId
      const draft = await DraftCV.findById(application.draftCVId || application.resumeId);
      if (draft) {
        resumeText = buildMarkdownFromDraft(draft);
      }
    }

    // Resolve job description (works for both Job and JobSearch references)
    const jobData = await resolveJobDescription(application);
    if (!jobData || !resumeText) {
      return res.status(404).json({ message: "Resume or Job not found" });
    }

    // Pre-flight balance check
    const COSTS = await settingsService.getCreditCosts();
    checkCredits(user, COSTS.GENERATE_COVER_LETTER);

    const coverLetter = await aiService.generateCoverLetter(resumeText, jobData.description, {
      userId,
      applicationId: application._id,
      model: aiService.resolveTextModel(user),
    });

    // AI succeeded — now charge the user
    const remainingCredits = await deductCredits(user, COSTS.GENERATE_COVER_LETTER);

    // Best-effort post-generation fact check. The function never throws —
    // failures return [] so the user always sees their letter.
    const coverLetterWarnings = await aiService.factCheckCoverLetter(resumeText, coverLetter, {
      userId,
      applicationId: application._id,
    });

    application.coverLetter = coverLetter;
    application.coverLetterWarnings = coverLetterWarnings;
    await application.save();

    res.status(200).json({
      coverLetter,
      coverLetterWarnings,
      remainingCredits,
    });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Cover Letter Generation Error:", error.message);
    res.status(500).json({
      message: "Failed to generate cover letter. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * POST /analysis/:id/generate-interview
 *
 * Generate interview prep for an existing application (5 credits)
 */
const generateApplicationInterview = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const user = req.user;

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    // Resolve job description (works for both Job and JobSearch references)
    const jobData = await resolveJobDescription(application);
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }

    // Pre-flight balance check
    const COSTS = await settingsService.getCreditCosts();
    checkCredits(user, COSTS.GENERATE_INTERVIEW);

    // Build the FULL candidate context so the AI can ground both questions and
    // suggested answers in real entries (no fabrication). Pass entire arrays —
    // the prompt indexes them so the AI can cite specific items via refIndex.
    let candidateContext = null;
    try {
      candidateContext = await buildInterviewCandidateContext(application, {
        userId,
        applicationId: application._id,
      });
    } catch (e) {
      console.error("[Interview] Failed to build candidate context:", e.message);
    }

    // Hard gate: without at least one real work-history entry to anchor STAR
    // answers in, the AI fabricates roles (e.g. recites the JD's role as if
    // it were the candidate's). Block and nudge to add a CV — no credits spent.
    if (!hasGroundableExperience(candidateContext)) {
      return res.status(422).json({
        code: "NO_CV_GROUNDING",
        message:
          "Add or generate a CV with at least one work experience entry before generating interview prep — this prevents the AI from inventing roles.",
      });
    }

    const aiResult = await aiService.generateInterviewQuestions(
      jobData.description,
      candidateContext,
      { userId, applicationId: application._id }
    );

    // AI succeeded — now charge the user
    const remainingCredits = await deductCredits(user, COSTS.GENERATE_INTERVIEW);

    // Post-generation fact-check: scan suggestedAnswers for companies/roles/
    // metrics not in the candidate profile. Advisory only — failures return []
    // and never block the user from seeing their prep.
    const fabricationWarnings = await aiService.factCheckInterviewQuestions(
      candidateContext,
      aiResult.jobQuestions || [],
      { userId, applicationId: application._id }
    );

    // Persist to the unified interviewPrep schema. Legacy fields
    // (interviewQuestions / questionsToAsk) remain on the model for
    // backward compatibility with old applications but are no longer written.
    application.interviewPrep = application.interviewPrep || {};
    application.interviewPrep.jobQuestions = aiResult.jobQuestions || [];
    application.interviewPrep.questionsToAsk = aiResult.questionsToAsk || [];
    application.interviewPrep.fabricationWarnings = fabricationWarnings;
    await application.save();

    const interviewPrep = serializeInterviewPrep(application);

    res.status(200).json({
      interviewQuestions: aiResult.questionsToAnswer || [],
      questionsToAsk: interviewPrep.questionsToAsk,
      jobQuestions: interviewPrep.jobQuestions,
      interviewPrep,
      remainingCredits,
    });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Interview Generation Error:", error.message);
    res.status(500).json({
      message: "Failed to generate interview prep. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * POST /analysis/direct-interview
 *
 * Standalone "Interview Me" flow — a paid-only shortcut that skips the full
 * ApplyRight analysis (no fit score, no CV optimization, no cover letter) and
 * takes the user straight from CV + job description to a live interview.
 *
 * Reuses all the existing interview machinery: it find-or-creates a lightweight
 * Application (no fitAnalysis, no analyze charge), generates the grounded
 * question set, and returns the applicationId so the client can drop into the
 * existing mock-interview UI. The live-minute metering still happens later in
 * createRealtimeSession.
 *
 * The CV may be an uploaded Resume (resumeId) OR a built CV (draftCVId). The
 * job description is REQUIRED. Paid-tier gating is enforced by requireTier in
 * the route, so there is no per-action credit charge here.
 */
const startDirectInterview = async (req, res) => {
  try {
    const { jobId, resumeId, draftCVId } = req.body;
    const userId = req.user._id;

    if (!jobId) {
      return res
        .status(400)
        .json({ message: "A job description is required to start an interview." });
    }
    if (!resumeId && !draftCVId) {
      return res.status(400).json({ message: "Select a saved CV or upload a resume first." });
    }

    // Job must exist and carry a usable description to interview against.
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ message: "Job not found." });
    }
    if (!job.description || !job.description.trim()) {
      return res
        .status(400)
        .json({ message: "This job has no description to interview against." });
    }

    // Verify CV ownership before linking it.
    if (draftCVId) {
      const draft = await DraftCV.findOne({ _id: draftCVId, userId }).select("_id");
      if (!draft) return res.status(404).json({ message: "Saved CV not found." });
    }
    if (resumeId) {
      const resume = await Resume.findOne({ _id: resumeId, userId }).select("_id");
      if (!resume) return res.status(404).json({ message: "Resume not found." });
    }

    // Find-or-create a lightweight Application (analysis fields intentionally
    // left unset — this flow never scores fit). Re-running with the same CV+job
    // reuses the existing prep instead of piling up duplicates.
    const query = { userId, jobId };
    if (resumeId) query.resumeId = resumeId;
    if (draftCVId) query.draftCVId = draftCVId;

    let application = await Application.findOne(query);
    if (!application) {
      application = new Application({
        userId,
        jobId,
        ...(resumeId ? { resumeId } : {}),
        ...(draftCVId ? { draftCVId } : {}),
        jobTitle: job.title,
        jobCompany: job.company,
      });
    }

    // Build the candidate context and hard-gate on groundable experience (same
    // guard as generate-interview) so the AI never invents past roles.
    let candidateContext = null;
    try {
      candidateContext = await buildInterviewCandidateContext(application, {
        userId,
        applicationId: application._id,
      });
    } catch (e) {
      console.error("[DirectInterview] Failed to build candidate context:", e.message);
    }
    if (!hasGroundableExperience(candidateContext)) {
      return res.status(422).json({
        code: "NO_CV_GROUNDING",
        message:
          "This CV needs at least one work experience entry (role and company) before we can run a grounded interview.",
      });
    }

    // Generate the question spine so the live interviewer has real material.
    const aiResult = await aiService.generateInterviewQuestions(
      job.description,
      candidateContext,
      { userId, applicationId: application._id }
    );

    const fabricationWarnings = await aiService.factCheckInterviewQuestions(
      candidateContext,
      aiResult.jobQuestions || [],
      { userId, applicationId: application._id }
    );

    application.interviewPrep = application.interviewPrep || {};
    application.interviewPrep.jobQuestions = aiResult.jobQuestions || [];
    application.interviewPrep.questionsToAsk = aiResult.questionsToAsk || [];
    application.interviewPrep.fabricationWarnings = fabricationWarnings;
    await application.save();

    return res.status(200).json({
      applicationId: application._id,
      interviewPrep: serializeInterviewPrep(application),
    });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Direct Interview Error:", error.message);
    res.status(500).json({
      message: "Failed to start the interview. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * POST /analysis/:id/generate-more-interview
 *
 * Generate ADDITIONAL interview questions for an existing application,
 * avoiding duplicates of the questions already on `interviewPrep.jobQuestions`.
 * Costs 5 credits (same as initial generation).
 *
 * Returns the full updated jobQuestions list plus a `newQuestionIndices`
 * array marking which entries are new so the frontend can badge them.
 */
const generateMoreApplicationInterview = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const user = req.user;

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const jobData = await resolveJobDescription(application);
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }

    const COSTS = await settingsService.getCreditCosts();
    checkCredits(user, COSTS.GENERATE_INTERVIEW_MORE);

    let candidateContext = null;
    try {
      candidateContext = await buildInterviewCandidateContext(application, {
        userId,
        applicationId: application._id,
      });
    } catch (e) {
      console.error("[Interview-More] Failed to build candidate context:", e.message);
    }

    if (!hasGroundableExperience(candidateContext)) {
      return res.status(422).json({
        code: "NO_CV_GROUNDING",
        message:
          "Add or generate a CV with at least one work experience entry before generating more interview questions.",
      });
    }

    const existing = application.interviewPrep?.jobQuestions || [];
    const existingTexts = existing
      .map((q) => (typeof q === "string" ? q : q?.question))
      .filter(Boolean);

    const aiResult = await aiService.generateInterviewQuestions(
      jobData.description,
      candidateContext,
      { userId, applicationId: application._id, operation: "generateMoreInterviewQuestions" },
      { existingQuestions: existingTexts }
    );

    const remainingCredits = await deductCredits(user, COSTS.GENERATE_INTERVIEW_MORE);

    const newJobQuestions = Array.isArray(aiResult.jobQuestions) ? aiResult.jobQuestions : [];
    const newQuestionsToAsk = Array.isArray(aiResult.questionsToAsk) ? aiResult.questionsToAsk : [];

    application.interviewPrep = application.interviewPrep || {};
    const startIdx = existing.length;
    const mergedJobQuestions = [...existing, ...newJobQuestions];
    application.interviewPrep.jobQuestions = mergedJobQuestions;

    // Merge questionsToAsk too, de-duped by case-insensitive match
    const askExisting = Array.isArray(application.interviewPrep.questionsToAsk)
      ? application.interviewPrep.questionsToAsk
      : [];
    const askSeen = new Set(askExisting.map((q) => String(q).trim().toLowerCase()));
    const askAdditions = newQuestionsToAsk.filter(
      (q) => !askSeen.has(String(q).trim().toLowerCase())
    );
    application.interviewPrep.questionsToAsk = [...askExisting, ...askAdditions];

    // Fact-check the new questions only (existing ones were already checked
    // when they were originally generated) and merge into the warnings list.
    const newWarnings = await aiService.factCheckInterviewQuestions(
      candidateContext,
      newJobQuestions,
      { userId, applicationId: application._id }
    );
    // Re-index new warnings to match their final position in the merged list.
    const shiftedNewWarnings = newWarnings.map((w) => ({
      index: w.index + startIdx,
      unsupportedClaims: w.unsupportedClaims,
    }));
    const existingWarnings = Array.isArray(application.interviewPrep.fabricationWarnings)
      ? application.interviewPrep.fabricationWarnings
      : [];
    application.interviewPrep.fabricationWarnings = [...existingWarnings, ...shiftedNewWarnings];

    application.markModified("interviewPrep.jobQuestions");
    application.markModified("interviewPrep.questionsToAsk");
    application.markModified("interviewPrep.fabricationWarnings");
    await application.save();

    const interviewPrep = serializeInterviewPrep(application);
    const newIndices = newJobQuestions.map((_, i) => startIdx + i);

    res.status(200).json({
      jobQuestions: interviewPrep.jobQuestions,
      questionsToAsk: interviewPrep.questionsToAsk,
      newQuestionIndices: newIndices,
      addedCount: newJobQuestions.length,
      interviewPrep,
      remainingCredits,
    });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Interview-More Generation Error:", error.message);
    res.status(500).json({
      message: "Failed to generate additional interview questions. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * POST /analysis/:id/generate-stories
 *
 * Generate a Story Bank for an existing application — reusable STAR stories
 * grounded in the candidate's real history. Mirrors generateApplicationInterview:
 * same grounding gate, fact-check, and charge-only-on-success contract.
 * Reached through the ad-reward flow on the frontend (nets out free).
 */
const generateApplicationStories = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const user = req.user;

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const jobData = await resolveJobDescription(application);
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }

    const COSTS = await settingsService.getCreditCosts();
    checkCredits(user, COSTS.GENERATE_STORIES);

    let candidateContext = null;
    try {
      candidateContext = await buildInterviewCandidateContext(application, {
        userId,
        applicationId: application._id,
      });
    } catch (e) {
      console.error("[Stories] Failed to build candidate context:", e.message);
    }

    // Same hard gate as interview questions: without a real work-history entry
    // to anchor STAR stories in, the AI fabricates roles. Block, no charge.
    if (!hasGroundableExperience(candidateContext)) {
      return res.status(422).json({
        code: "NO_CV_GROUNDING",
        message:
          "Add or generate a CV with at least one work experience entry before generating a story bank — this prevents the AI from inventing roles.",
      });
    }

    const aiResult = await aiService.generateInterviewStories(jobData.description, candidateContext, {
      userId,
      applicationId: application._id,
    });

    const remainingCredits = await deductCredits(user, COSTS.GENERATE_STORIES);

    // Normalize + stamp a stable id on every story so confidence/edits can
    // address them after the array is re-sorted or edited.
    const rawStories = Array.isArray(aiResult.stories) ? aiResult.stories : [];
    const stories = rawStories.map((s) => ({
      id: crypto.randomUUID(),
      title: typeof s.title === "string" ? s.title : "",
      theme: typeof s.theme === "string" ? s.theme : undefined,
      situation: typeof s.situation === "string" ? s.situation : "",
      task: typeof s.task === "string" ? s.task : "",
      action: typeof s.action === "string" ? s.action : "",
      result: typeof s.result === "string" ? s.result : "",
      skillsProven: Array.isArray(s.skillsProven)
        ? s.skillsProven.filter((x) => typeof x === "string")
        : [],
      answersQuestions: Array.isArray(s.answersQuestions)
        ? s.answersQuestions.filter((x) => typeof x === "string")
        : [],
      sourcedFrom: Array.isArray(s.sourcedFrom) ? s.sourcedFrom : [],
    }));

    const storyFabricationWarnings = await aiService.factCheckStories(candidateContext, stories, {
      userId,
      applicationId: application._id,
    });

    application.interviewPrep = application.interviewPrep || {};
    application.interviewPrep.stories = stories;
    application.interviewPrep.storyFabricationWarnings = storyFabricationWarnings;
    application.markModified("interviewPrep.stories");
    application.markModified("interviewPrep.storyFabricationWarnings");
    await application.save();

    const interviewPrep = serializeInterviewPrep(application);

    res.status(200).json({
      stories: interviewPrep.stories,
      storyFabricationWarnings: interviewPrep.storyFabricationWarnings,
      interviewPrep,
      remainingCredits,
    });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Story Bank Generation Error:", error.message);
    res.status(500).json({
      message: "Failed to generate story bank. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * POST /analysis/:id/generate-essential   body: { kind: 'intro' | 'motivation' }
 *
 * Generate a personalized answer to a universal "essential" question (Tell me
 * about yourself / Why this company), grounded in the CV (+ job for motivation),
 * and slot it into interviewPrep.jobQuestions as a first-class question of that
 * type — so it groups under its category and is practiceable/gradeable. Costs 2
 * credits (web) / ad-rewarded (Android). Re-generating replaces the existing one.
 */
const generateApplicationEssential = async (req, res) => {
  try {
    const { id } = req.params;
    const { kind } = req.body || {};
    const userId = req.user._id;
    const user = req.user;

    if (kind !== "intro" && kind !== "motivation") {
      return res.status(400).json({ message: "kind must be 'intro' or 'motivation'" });
    }

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const jobData = await resolveJobDescription(application);
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }

    const COSTS = await settingsService.getCreditCosts();
    checkCredits(user, COSTS.GENERATE_ESSENTIAL);

    let candidateContext = null;
    try {
      candidateContext = await buildInterviewCandidateContext(application, {
        userId,
        applicationId: application._id,
      });
    } catch (e) {
      console.error("[Essential] Failed to build candidate context:", e.message);
    }

    if (!hasGroundableExperience(candidateContext)) {
      return res.status(422).json({
        code: "NO_CV_GROUNDING",
        message:
          "Add or generate a CV with at least one work experience entry before generating this answer.",
      });
    }

    const newQuestion = await aiService.generateEssentialAnswer(
      kind,
      jobData.description,
      candidateContext,
      { userId, applicationId: application._id }
    );

    const remainingCredits = await deductCredits(user, COSTS.GENERATE_ESSENTIAL);

    const warns = await aiService.factCheckInterviewQuestions(candidateContext, [newQuestion], {
      userId,
      applicationId: application._id,
    });

    application.interviewPrep = application.interviewPrep || {};
    const jq = Array.isArray(application.interviewPrep.jobQuestions)
      ? application.interviewPrep.jobQuestions
      : [];

    // Replace the existing essential of this kind in place (keeps indices and
    // their fabrication warnings aligned); otherwise append.
    const existingIdx = jq.findIndex((q) => q.type === kind);
    let idx;
    if (existingIdx >= 0) {
      jq[existingIdx] = { ...newQuestion };
      idx = existingIdx;
    } else {
      jq.push({ ...newQuestion });
      idx = jq.length - 1;
    }
    application.interviewPrep.jobQuestions = jq;

    const fw = Array.isArray(application.interviewPrep.fabricationWarnings)
      ? application.interviewPrep.fabricationWarnings.filter((w) => w.index !== idx)
      : [];
    if (warns.length && warns[0].unsupportedClaims?.length) {
      fw.push({ index: idx, unsupportedClaims: warns[0].unsupportedClaims });
    }
    application.interviewPrep.fabricationWarnings = fw;

    application.markModified("interviewPrep.jobQuestions");
    application.markModified("interviewPrep.fabricationWarnings");
    await application.save();

    const interviewPrep = serializeInterviewPrep(application);

    res.status(200).json({
      kind,
      index: idx,
      jobQuestions: interviewPrep.jobQuestions,
      fabricationWarnings: interviewPrep.fabricationWarnings,
      interviewPrep,
      remainingCredits,
    });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Essential Generation Error:", error.message);
    res.status(500).json({
      message: "Failed to generate the answer. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * POST /analysis/:id/generate-dress-guide
 *
 * Generate a tailored "what to wear / first impression" guide for this role.
 * Job-linked only (mirrors generate-essential). No CV grounding required.
 */
const generateDressGuide = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const user = req.user;

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const jobData = await resolveJobDescription(application);
    if (!jobData) {
      return res.status(404).json({ message: "Job not found" });
    }

    const COSTS = await settingsService.getCreditCosts();
    checkCredits(user, COSTS.GENERATE_DRESS_GUIDE);

    const guide = await aiService.generateDressGuide(
      stringifyDescription(jobData.description),
      {
        jobTitle: application.jobTitle || jobData.title || "",
        company: application.jobCompany || jobData.company || "",
      },
      { userId, applicationId: application._id }
    );

    const remainingCredits = await deductCredits(user, COSTS.GENERATE_DRESS_GUIDE);

    const dressGuide = { ...guide, generatedAt: new Date() };
    application.interviewPrep = application.interviewPrep || {};
    application.interviewPrep.dressGuide = dressGuide;
    application.markModified("interviewPrep.dressGuide");
    await application.save();

    res.status(200).json({ dressGuide, remainingCredits });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Dress Guide Generation Error:", error.message);
    res.status(500).json({
      message: "Failed to generate the dress guide. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * POST /analysis/:id/generate-bundle
 *
 * Generate the full application kit (CV + cover letter + interview prep) in
 * one async pipeline at a discounted rate (18 credits vs. 20 individually).
 *
 * Behavior:
 *   - Pre-flight check 18 credits (no deduct).
 *   - Return 202 immediately with `{ applicationId, generationStatus }`.
 *   - Run the existing async CV pipeline with `chargeOnSuccess: false`.
 *   - On CV success, run cover letter (with fact-check) inline.
 *   - On cover letter success, run interview prep inline.
 *   - All-or-nothing: charge 18 credits ONLY when all three complete. If any
 *     stage fails, the user is not charged at all (the partial CV stays on
 *     the application as a usable byproduct — generous in v1).
 */
const generateApplicationBundle = async (req, res) => {
  try {
    const { id } = req.params;
    const { templateId, providedMetrics } = req.body || {};
    const userId = req.user._id;
    const user = req.user;

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const inFlightStages = new Set([
      "extracting",
      "scoring",
      "enhancing",
      "categorizing",
      "assembling",
    ]);
    if (application.generationStatus && inFlightStages.has(application.generationStatus.stage)) {
      return res.status(409).json({
        message: "A generation is already in progress for this application.",
        code: "GENERATION_IN_PROGRESS",
        generationStatus: application.generationStatus,
      });
    }

    const [resume, job] = await Promise.all([
      Resume.findById(application.resumeId),
      Job.findById(application.jobId),
    ]);
    if (!resume || !job) {
      return res.status(404).json({ message: "Resume or Job not found" });
    }

    const COSTS = await settingsService.getCreditCosts();
    checkCredits(user, COSTS.GENERATE_BUNDLE);

    // Mark CV stage so the polling UI sees motion immediately.
    application.generationStatus = {
      stage: "extracting",
      progress: CV_STAGES.extracting.progress,
      stageMessage: CV_STAGES.extracting.message,
      startedAt: new Date(),
      completedAt: undefined,
      error: undefined,
    };
    await application.save();

    res.status(202).json({
      applicationId: application._id,
      generationStatus: application.generationStatus,
      bundle: true,
    });

    // Fire-and-forget bundle pipeline. Errors caught inside, never bubble out.
    (async () => {
      try {
        // Stage 1: CV pipeline (skip charge — bundle owns it)
        const cvResult = await runCVGenerationPipeline({
          application,
          resume,
          job,
          user,
          templateId,
          chargeOnSuccess: false,
          providedMetrics,
        });

        // Stage 2: Cover letter (resume text from raw resume)
        const coverLetter = await aiService.generateCoverLetter(resume.rawText, job.description, {
          userId,
          applicationId: application._id,
          model: aiService.resolveTextModel(user),
        });
        const coverLetterWarnings = await aiService.factCheckCoverLetter(
          resume.rawText,
          coverLetter,
          { userId, applicationId: application._id }
        );

        // Stage 3: Interview prep — pass full candidate context so AI can ground
        // suggested answers in real entries (no fabrication).
        let candidateContext = null;
        try {
          candidateContext = await buildInterviewCandidateContext(
            { ...application.toObject(), draftCVId: cvResult.draftId },
            { userId, applicationId: application._id }
          );
        } catch (e) {
          console.error("[Bundle] Failed to build candidate context:", e.message);
        }

        // Soft gate in the bundle: if grounding is missing, skip the interview
        // stage rather than break the whole bundle. CV + cover letter still
        // ship; the user can re-run interview prep alone after filling out the
        // CV. Surface a warning the frontend can render.
        const groundable = hasGroundableExperience(candidateContext);
        let interviewResult = null;
        let interviewWarnings = [];
        if (groundable) {
          interviewResult = await aiService.generateInterviewQuestions(
            job.description,
            candidateContext,
            { userId, applicationId: application._id }
          );
          interviewWarnings = await aiService.factCheckInterviewQuestions(
            candidateContext,
            interviewResult?.jobQuestions || [],
            { userId, applicationId: application._id }
          );
        } else {
          console.log(
            `[Bundle] Skipping interview prep for ${application._id} — no groundable CV experience.`
          );
        }
        const questionsToAsk = interviewResult?.questionsToAsk || [];
        const jobQuestionsRich = interviewResult?.jobQuestions || [];

        // All three succeeded — charge once at bundle rate.
        await deductCredits(user, COSTS.GENERATE_BUNDLE);

        // Persist the additional artifacts onto the application doc. Re-fetch
        // because runCVGenerationPipeline already modified `fresh`.
        const finalApp = await Application.findById(application._id);
        if (finalApp) {
          finalApp.coverLetter = coverLetter;
          finalApp.coverLetterWarnings = coverLetterWarnings;
          if (groundable) {
            finalApp.interviewPrep = finalApp.interviewPrep || {};
            finalApp.interviewPrep.jobQuestions = jobQuestionsRich;
            finalApp.interviewPrep.questionsToAsk = questionsToAsk;
            finalApp.interviewPrep.fabricationWarnings = interviewWarnings;
          } else {
            const warnings = Array.isArray(finalApp.bundleWarnings)
              ? finalApp.bundleWarnings
              : [];
            if (!warnings.includes("interview_skipped_no_cv")) {
              finalApp.bundleWarnings = [...warnings, "interview_skipped_no_cv"];
            }
          }
          await finalApp.save();
        }

        console.log(
          `[Bundle] Complete for ${application._id}. Score: ${cvResult.beforeScore} → ${cvResult.afterScore}. Warnings: ${coverLetterWarnings.length}.`
        );
      } catch (err) {
        console.error("[Bundle] Pipeline failed:", err.message);
        // Bundle pipeline failures already write a 'failed' generationStatus
        // via runCVGenerationPipeline OR leave the doc in a non-bundle state
        // if the failure was after CV. No charge has been applied.
      }
    })().catch((e) => console.error("[Bundle] Unhandled top-level error:", e));
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Bundle Generation Error:", error.message, error.stack);
    res.status(500).json({
      message: "Failed to start bundle generation. You have not been charged.",
      error: error.message,
    });
  }
};

/**
 * POST /analysis/:id/edit
 *
 * Create a DraftCV from an application's optimized CV for editing in the builder
 */
/**
 * POST /analysis/:id/preflight-metrics
 *
 * Cheap pre-flight before CV generation. Returns the small set of "vague"
 * bullets the user could improve by supplying numbers (team size, percentages,
 * scale). The extraction calls are cached so on the warm path this is sub-100ms.
 *
 * No charge. No AI work beyond reading the cached extractions. If extractions
 * miss the cache, the call still runs them — 1-2 LLM calls — because we need
 * the bullet text to detect from. That cost is borne by the analyze step the
 * user already paid for; we do not deduct here.
 */
const preflightMetrics = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const [resume, job] = await Promise.all([
      Resume.findById(application.resumeId),
      Job.findById(application.jobId),
    ]);
    if (!resume || !job) {
      return res.status(404).json({ message: "Resume or Job not found" });
    }

    const meta = { userId, applicationId: application._id };
    const [candidateData, jobData] = await Promise.all([
      aiService.extractCandidateData(resume.rawText, meta),
      aiService.extractJobRequirements(job.description, meta),
    ]);
    if (!jobData.detectedJobTitle) jobData.detectedJobTitle = job.title;
    if (!jobData.detectedCompany) jobData.detectedCompany = job.company;

    const rankedExperiences = cvOptimizer.rankExperiences(candidateData.experience || [], jobData);
    const vagueBullets = metricCapture.detectVagueBullets(rankedExperiences);

    return res.json({ vagueBullets });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Preflight metrics error:", error.message);
    // Non-fatal — fall through with an empty list so the user can still proceed.
    return res.json({ vagueBullets: [] });
  }
};

const editApplication = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const application = await Application.findOne({ _id: id, userId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const cvText = application.optimizedCV || "";
    if (!cvText) {
      return res.status(400).json({ message: "No CV content to edit. Generate a CV first." });
    }

    // Idempotency: if a draft was already created from this application in the
    // last 10 minutes, return that one instead of running the (slow, AI-backed)
    // extraction again. Protects against double-clicks and connection-drop
    // retries that would otherwise leave duplicate "Edit of X" drafts behind.
    const TEN_MIN = 10 * 60 * 1000;
    const recent = await DraftCV.findOne({
      userId,
      sourceApplicationId: application._id,
      createdAt: { $gte: new Date(Date.now() - TEN_MIN) },
    })
      .sort({ createdAt: -1 })
      .lean();
    if (recent) {
      return res.status(200).json({
        message: "Existing draft returned",
        draftId: recent._id,
        cached: true,
      });
    }

    // Extract structured data from the optimized CV markdown
    const extractedData = await aiService.extractResumeProfile(cvText);

    // Use stored skills if available, otherwise regenerate
    let structuredSkills = [];
    if (application.skills && application.skills.length > 0) {
      structuredSkills = application.skills.map((s) => ({
        name: s.name,
        category: s.category,
        isAutoGenerated: true,
      }));
    } else {
      structuredSkills = await aiService.generateStructuredSkills(
        {
          education: extractedData.education,
          experience: extractedData.experience,
          projects: extractedData.projects,
          targetJob: null,
        },
        { model: aiService.resolveTextModel(req.user) }
      );
      structuredSkills = structuredSkills.map((s) => ({ ...s, isAutoGenerated: true }));
    }

    const draft = await DraftCV.create({
      userId,
      sourceApplicationId: application._id,
      title: `Edit of ${application.jobId ? (await Job.findById(application.jobId))?.title || "Application" : "Application"}`,
      personalInfo: {
        fullName: req.user.firstName ? `${req.user.firstName} ${req.user.lastName}` : "Candidate",
        email: req.user.email,
        phone: req.user.phone || "",
        linkedin: req.user.linkedinUrl || "",
        website: req.user.portfolioUrl || "",
        address: req.user.location || "",
      },
      professionalSummary: extractedData.summary || "",
      experience:
        extractedData.experience?.map((e) => ({
          title: e.role,
          company: e.company,
          startDate: e.startDate,
          endDate: e.endDate,
          description: Array.isArray(e.description)
            ? e.description.map((d) => `• ${d}`).join("\n")
            : e.description || "",
        })) || [],
      education:
        extractedData.education?.map((e) => ({
          degree: e.degree,
          school: e.school,
          field: e.field,
          graduationDate: e.date,
        })) || [],
      projects:
        extractedData.projects?.map((p) => ({
          title: p.title,
          link: p.link,
          description: Array.isArray(p.description)
            ? p.description.map((d) => `• ${d}`).join("\n")
            : p.description || "",
        })) || [],
      skills: structuredSkills,
      isComplete: true,
    });

    return res.status(200).json({
      message: "Draft created from Application",
      draftId: draft._id,
    });
  } catch (error) {
    if (handleAIError(res, error)) return;
    console.error("Edit Application Error:", error);
    res.status(500).json({
      message: "Failed to prepare edit. You have not been charged.",
      error: error.message,
    });
  }
};

module.exports = {
  analyzeFit,
  generateApplicationCV,
  generateApplicationCoverLetter,
  generateApplicationInterview,
  startDirectInterview,
  generateMoreApplicationInterview,
  generateApplicationStories,
  generateApplicationEssential,
  generateDressGuide,
  generateApplicationBundle,
  preflightMetrics,
  editApplication,
  buildInterviewCandidateContext,
};
