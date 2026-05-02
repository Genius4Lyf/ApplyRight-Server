const Job = require("../models/Job");
const JobSearch = require("../models/JobSearch");
const DraftCV = require("../models/DraftCV");
const Resume = require("../models/Resume");
const Application = require("../models/Application");
const extractionService = require("../services/extraction.service");
const aiService = require("../services/ai.service");
const cvOptimizer = require("../services/cvOptimizer.service");
const metricCapture = require("../services/metricCapture.service");

// Credit costs
const COSTS = {
  ANALYSIS: 10,
  GENERATE_CV: 10,
  GENERATE_COVER_LETTER: 5,
  GENERATE_INTERVIEW: 5,
  CREATE_FROM_UPLOAD: 15,
  // Bundle: CV (10) + Cover letter (5) + Interview prep (5) = 20 individually,
  // 18 as a bundle (10% discount, save 2 credits). All-or-nothing in v1: if
  // any stage fails, the user is not charged at all.
  GENERATE_BUNDLE: 18,
};

/**
 * Helper: Verify the user has sufficient credits BEFORE running expensive AI work.
 * Throws an INSUFFICIENT_CREDITS error if the balance is too low.
 * Does NOT deduct — call deductCredits only after AI work succeeds.
 */
const checkCredits = (user, cost) => {
  if (user.credits < cost) {
    const err = new Error("Insufficient credits");
    err.code = "INSUFFICIENT_CREDITS";
    err.required = cost;
    err.current = user.credits;
    throw err;
  }
};

/**
 * Helper: Deduct credits atomically and return the new balance.
 * Call this only after AI work has succeeded so users are never charged
 * for failed or unavailable AI calls.
 */
const deductCredits = async (user, cost) => {
  checkCredits(user, cost);
  user.credits -= cost;
  await user.updateOne({ credits: user.credits });
  return user.credits;
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
      message: "AI service is temporarily unavailable. You have not been charged. Please try again later.",
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
    const result = search.results.find(
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

/**
 * POST /analysis/analyze
 *
 * Two modes:
 * - With jobId: Analyze resume vs job (10 credits) → returns fitScore, fitAnalysis, actionPlan
 * - Without jobId: Create from upload (15 credits) → returns draftId
 */
const analyzeFit = async (req, res) => {
  try {
    const { jobId, resumeId } = req.body;
    const userId = req.user._id;
    const user = req.user;

    const resume = await Resume.findById(resumeId);
    if (!resume) {
      return res.status(404).json({ message: "Resume not found" });
    }

    // ── Create from Upload (no job) ──
    if (!jobId) {
      checkCredits(user, COSTS.CREATE_FROM_UPLOAD);

      const meta = { userId };
      const extractedData = await aiService.extractResumeProfile(resume.rawText, meta);

      const structuredSkills = await aiService.generateStructuredSkills({
        education: extractedData.education,
        experience: extractedData.experience,
        projects: extractedData.projects,
        targetJob: null,
      }, meta);

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
    const aiResult = await aiService.analyzeProfile(resume.rawText, job.description, { userId });

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

    // Save or update Application — analysis fields only
    let application = await Application.findOne({ userId, jobId, resumeId });

    if (!application) {
      application = new Application({
        userId,
        jobId,
        resumeId,
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
const runCVGenerationPipeline = async ({ application, resume, job, user, templateId, chargeOnSuccess = true, providedMetrics = {} }) => {
  const userId = user._id;
  const applicationId = application._id;
  const meta = { userId, applicationId };

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
    if (
      application.generationStatus &&
      inFlightStages.has(application.generationStatus.stage)
    ) {
      return res.status(409).json({
        message: "A CV generation is already in progress for this application.",
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
    runCVGenerationPipeline({ application, resume, job, user, templateId, providedMetrics }).catch((e) => {
      console.error("[CV Pipeline] Unhandled top-level error:", e);
    });
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
    checkCredits(user, COSTS.GENERATE_COVER_LETTER);

    const coverLetter = await aiService.generateCoverLetter(resumeText, jobData.description, {
      userId,
      applicationId: application._id,
    });

    // AI succeeded — now charge the user
    const remainingCredits = await deductCredits(user, COSTS.GENERATE_COVER_LETTER);

    // Best-effort post-generation fact check. The function never throws —
    // failures return [] so the user always sees their letter.
    const coverLetterWarnings = await aiService.factCheckCoverLetter(
      resumeText,
      coverLetter,
      { userId, applicationId: application._id }
    );

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
    checkCredits(user, COSTS.GENERATE_INTERVIEW);

    // Build the FULL candidate context so the AI can ground both questions and
    // suggested answers in real entries (no fabrication). Pass entire arrays —
    // the prompt indexes them so the AI can cite specific items via refIndex.
    let candidateContext = null;
    try {
      const draft =
        application.draftCVId && (await DraftCV.findById(application.draftCVId));
      if (draft) {
        candidateContext = {
          summary: draft.professionalSummary,
          experience: (draft.experience || []).map((e) => ({
            role: e.title,
            company: e.company,
            description: e.description,
          })),
          education: (draft.education || []).map((e) => ({
            degree: e.degree,
            school: e.school,
            description: e.description,
          })),
          projects: (draft.projects || []).map((p) => ({
            title: p.title,
            description: p.description,
          })),
          skills: (application.skills || draft.skills || []).map((s) => s.name).filter(Boolean),
        };
      }
    } catch (e) {
      // Non-critical — fall back to JD-only prompt
      console.error("[Interview] Failed to build candidate context:", e.message);
    }

    const aiResult = await aiService.generateInterviewQuestions(
      jobData.description,
      candidateContext,
      { userId, applicationId: application._id }
    );

    // AI succeeded — now charge the user
    const remainingCredits = await deductCredits(user, COSTS.GENERATE_INTERVIEW);

    // Persist to the unified interviewPrep schema. Legacy fields
    // (interviewQuestions / questionsToAsk) remain on the model for
    // backward compatibility with old applications but are no longer written.
    application.interviewPrep = application.interviewPrep || {};
    application.interviewPrep.jobQuestions = aiResult.jobQuestions || [];
    application.interviewPrep.questionsToAsk = aiResult.questionsToAsk || [];
    await application.save();

    res.status(200).json({
      interviewQuestions: aiResult.questionsToAnswer || [],
      questionsToAsk: aiResult.questionsToAsk || [],
      jobQuestions: aiResult.jobQuestions || [],
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
      "extracting", "scoring", "enhancing", "categorizing", "assembling",
    ]);
    if (
      application.generationStatus &&
      inFlightStages.has(application.generationStatus.stage)
    ) {
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
        const coverLetter = await aiService.generateCoverLetter(
          resume.rawText,
          job.description,
          { userId, applicationId: application._id }
        );
        const coverLetterWarnings = await aiService.factCheckCoverLetter(
          resume.rawText,
          coverLetter,
          { userId, applicationId: application._id }
        );

        // Stage 3: Interview prep — pass full candidate context so AI can ground
        // suggested answers in real entries (no fabrication).
        let candidateContext = null;
        try {
          const draft = await DraftCV.findById(cvResult.draftId);
          if (draft) {
            candidateContext = {
              summary: draft.professionalSummary,
              experience: (draft.experience || []).map((e) => ({
                role: e.title,
                company: e.company,
                description: e.description,
              })),
              education: (draft.education || []).map((e) => ({
                degree: e.degree,
                school: e.school,
                description: e.description,
              })),
              projects: (draft.projects || []).map((p) => ({
                title: p.title,
                description: p.description,
              })),
              skills: (draft.skills || []).map((s) => s.name).filter(Boolean),
            };
          }
        } catch (e) {
          console.error("[Bundle] Failed to build candidate context:", e.message);
        }

        const interviewResult = await aiService.generateInterviewQuestions(
          job.description,
          candidateContext,
          { userId, applicationId: application._id }
        );
        const interviewQuestions = interviewResult.questionsToAnswer || [];
        const questionsToAsk = interviewResult.questionsToAsk || [];
        const jobQuestionsRich = interviewResult.jobQuestions || [];

        // All three succeeded — charge once at bundle rate.
        await deductCredits(user, COSTS.GENERATE_BUNDLE);

        // Persist the additional artifacts onto the application doc. Re-fetch
        // because runCVGenerationPipeline already modified `fresh`.
        const finalApp = await Application.findById(application._id);
        if (finalApp) {
          finalApp.coverLetter = coverLetter;
          finalApp.coverLetterWarnings = coverLetterWarnings;
          finalApp.interviewPrep = finalApp.interviewPrep || {};
          finalApp.interviewPrep.jobQuestions = jobQuestionsRich;
          finalApp.interviewPrep.questionsToAsk = questionsToAsk;
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

    const rankedExperiences = cvOptimizer.rankExperiences(
      candidateData.experience || [],
      jobData
    );
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
      structuredSkills = await aiService.generateStructuredSkills({
        education: extractedData.education,
        experience: extractedData.experience,
        projects: extractedData.projects,
        targetJob: null,
      });
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
  generateApplicationBundle,
  preflightMetrics,
  editApplication,
};
