const { generateOptimizedContent, generateInterviewQuestions } = require("../services/ai.service");
const Application = require("../models/Application");
const Resume = require("../models/Resume");
const Job = require("../models/Job");

// @desc    Generate optimized CV and Cover Letter
// @route   POST /api/ai/generate
// @access  Private
const generateApplication = async (req, res) => {
  const { resumeId, jobId, templateId } = req.body;

  if (!resumeId || !jobId) {
    return res.status(400).json({ message: "Please provide resumeId and jobId" });
  }

  try {
    const resume = await Resume.findById(resumeId);
    const job = await Job.findById(jobId);

    if (!resume || !job) {
      return res.status(404).json({ message: "Resume or Job not found" });
    }

    // Check if user owns the resume
    if (resume.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "Not authorized to use this resume" });
    }

    // Check for existing application
    let application = await Application.findOne({ userId: req.user.id, jobId, resumeId });

    // Check Usage Limits ONLY if creating a NEW application
    if (!application && req.user.plan === "free") {
      const applicationCount = await Application.countDocuments({ userId: req.user.id });
      if (applicationCount >= 2) {
        return res
          .status(403)
          .json({ message: "Free limit reached. Upgrade to Pro to create more applications." });
      }
    }

    const { optimizedCV, coverLetter } = await generateOptimizedContent(
      resume.rawText,
      job.description,
      {
        graduationYear: req.user.graduationYear, // Pass context
      }
    );

    // Generate Interview Questions (NEW)
    // We use extracted skills + job description
    const { questionsToAnswer: interviewQuestions, questionsToAsk } =
      await generateInterviewQuestions(job.description, null);

    if (application) {
      // Update existing
      application.optimizedCV = optimizedCV;
      application.coverLetter = coverLetter;
      application.templateId = templateId || "ats-clean";
      application.interviewQuestions = interviewQuestions;
      application.questionsToAsk = questionsToAsk;
      await application.save();
    } else {
      // Create new
      application = await Application.create({
        userId: req.user.id,
        resumeId,
        jobId,
        optimizedCV,
        coverLetter,
        templateId: templateId || "ats-clean",
        interviewQuestions: interviewQuestions,
        questionsToAsk: questionsToAsk,
      });
    }

    res.status(201).json(application);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to generate application" });
  }
};

// Of the AI's work-history bullets, free users receive only this many real
// suggestions; the rest are redacted to placeholders so the real text never
// leaves the server. Mirrored on the frontend (History.jsx → derived from the
// lockedCount the API returns). Keep this in sync with that expectation.
const FREE_VISIBLE_BULLETS = 4;

// Plausible-looking filler shown (blurred) in the locked slots as an upsell
// teaser. The real generated text is withheld from free users entirely.
const LOCKED_BULLET_PLACEHOLDERS = [
  "Spearheaded a cross-functional effort that streamlined daily operations and improved turnaround time.",
  "Partnered with stakeholders to close process gaps and deliver measurable quality improvements.",
  "Owned end-to-end delivery of a key workstream while balancing competing priorities under deadline.",
  "Introduced practical improvements that reduced rework and lifted overall team output.",
];

// @desc    Generate bullet points or summary
// @route   POST /api/ai/generate-bullets
// @access  Private
const generateBullets = async (req, res) => {
  const { role, context, type, targetJob } = req.body;

  // Basic validation
  if (!role && !context) {
    return res.status(400).json({ message: "Please provide role/title and some context." });
  }

  try {
    const suggestions = await require("../services/ai.service").generateBulletPoints(
      role,
      context,
      type,
      targetJob
    );

    // Plan gate (work-history bullets only): free users get the first 4 real
    // bullets; any extras are replaced with locked placeholders BEFORE the
    // response leaves the server, so the withheld suggestions can't be read via
    // dev tools. Paid users get everything.
    let out = suggestions;
    let lockedCount = 0;
    if (type === "experience" && Array.isArray(suggestions) && suggestions.length > FREE_VISIBLE_BULLETS) {
      const user = await require("../models/User").findById(req.user.id).select("plan");
      if (user?.plan !== "paid") {
        lockedCount = suggestions.length - FREE_VISIBLE_BULLETS;
        const locked = Array.from(
          { length: lockedCount },
          (_, i) => LOCKED_BULLET_PLACEHOLDERS[i % LOCKED_BULLET_PLACEHOLDERS.length]
        );
        out = [...suggestions.slice(0, FREE_VISIBLE_BULLETS), ...locked];
      }
    }

    res.json({ suggestions: out, lockedCount });
  } catch (error) {
    console.error("Bullet Gen Error:", error);
    res.status(500).json({ message: "Failed to generate suggestions" });
  }
};

// @desc    Generate categorized skills from profile context
// @route   POST /api/ai/generate-skills
// @access  Private
const generateSkills = async (req, res) => {
  const { education, experience, projects, targetJob } = req.body;
  const SKILLS_COST = 10;

  try {
    const user = await require("../models/User").findById(req.user.id);

    if (user.credits < SKILLS_COST) {
      return res.status(403).json({
        message: "Insufficient credits",
        code: "INSUFFICIENT_CREDITS",
        required: SKILLS_COST,
        current: user.credits,
      });
    }

    const suggestions = await require("../services/ai.service").generateSkillsFromContext(
      education || [],
      experience || [],
      projects || [],
      targetJob || ""
    );

    // Deduct credits
    user.credits -= SKILLS_COST;
    await user.updateOne({ credits: user.credits });

    // Record Transaction
    await require("../models/Transaction").create({
      userId: user.id,
      amount: -SKILLS_COST,
      type: "usage",
      description: "AI Skills Generation users profile context",
      status: "completed",
    });

    res.json({
      suggestions,
      remainingCredits: user.credits,
    });
  } catch (error) {
    console.error("Skills Gen Error:", error);
    res.status(500).json({ message: "Failed to generate skills" });
  }
};

// Paid "Find more keywords" cost. Mirrored in the frontend credit table
// (applyright-frontend/src/lib/credits.js → GENERATE_JD_KEYWORDS). Keep in sync.
const JD_KEYWORDS_COST = 5;

// Normalize a JD before hashing so trivial edits (whitespace/case) don't force
// a re-charge for what is effectively the same job description.
const hashJobDescription = (text) =>
  require("crypto")
    .createHash("sha256")
    .update((text || "").trim().toLowerCase().replace(/\s+/g, " "))
    .digest("hex");

// Flatten extractJobRequirements output into a deduped, importance-tagged list.
const mergeRequirementKeywords = (jobData = {}) => {
  const out = [];
  const seen = new Set();
  const push = (name, importance) => {
    const clean = (name || "").trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return; // must_have wins because it's pushed first
    seen.add(key);
    out.push({ name: clean, importance });
  };
  (jobData.requiredSkills || []).forEach((s) => push(s.name, "must_have"));
  (jobData.preferredSkills || []).forEach((s) => push(s.name, "nice_to_have"));
  return out;
};

// @desc    Suggest ATS keywords for the target job. Free baseline (deterministic
//          for a JD, cached AI inference for a title-only); paid "rich" mode runs
//          the AI JD parser, charged once per unique JD and cached on the draft.
// @route   POST /api/ai/job-keywords
// @access  Private
const getJobKeywords = async (req, res) => {
  const { targetJob, mode, draftId } = req.body || {};
  const title = (targetJob?.title || "").trim();
  const description = (targetJob?.description || "").trim();

  try {
    // ── Richer, AI-powered extraction (paid, charged once per JD) ──
    if (mode === "rich") {
      // Nothing richer to do without a JD — let the caller fall back to baseline.
      if (!description) {
        return res.json({ keywords: [], source: "none", charged: false });
      }

      // Charge-once enforcement needs a persisted draft to record the JD hash.
      if (!draftId || draftId === "new") {
        return res
          .status(400)
          .json({ code: "SAVE_REQUIRED", message: "Save your CV first to tailor keywords." });
      }
      const draft = await require("../models/DraftCV").findById(draftId);
      if (!draft || draft.userId.toString() !== req.user.id) {
        return res.status(404).json({ message: "Draft not found" });
      }

      const jdHash = hashJobDescription(description);

      // Already extracted for this exact JD → return cached, no charge.
      if (
        draft.targetJob?.aiKeywordsHash === jdHash &&
        Array.isArray(draft.targetJob?.aiKeywords) &&
        draft.targetJob.aiKeywords.length > 0
      ) {
        return res.json({
          keywords: draft.targetJob.aiKeywords,
          aiKeywordsHash: jdHash,
          source: "jd-ai",
          charged: false,
        });
      }

      // New/changed JD → verify credits before spending.
      const User = require("../models/User");
      const user = await User.findById(req.user.id);
      if (user.credits < JD_KEYWORDS_COST) {
        return res.status(403).json({
          message: "Insufficient credits",
          code: "INSUFFICIENT_CREDITS",
          required: JD_KEYWORDS_COST,
          current: user.credits,
        });
      }

      const jobData = await require("../services/ai.service").extractJobRequirements(description, {
        userId: req.user.id,
      });
      const keywords = mergeRequirementKeywords(jobData);

      // Persist on the draft so future views of either step are free. (Reaches
      // here only on a real AI call, so the user is genuinely getting new value.)
      if (!draft.targetJob) draft.targetJob = {};
      draft.targetJob.aiKeywords = keywords;
      draft.targetJob.aiKeywordsHash = jdHash;
      draft.markModified("targetJob");
      await draft.save();

      // Deduct credits + record the transaction (mirrors generateSkills).
      user.credits -= JD_KEYWORDS_COST;
      await user.updateOne({ credits: user.credits });
      await require("../models/Transaction").create({
        userId: user.id,
        amount: -JD_KEYWORDS_COST,
        type: "usage",
        description: "AI job keyword extraction (CV builder)",
        status: "completed",
      });

      return res.json({
        keywords,
        aiKeywordsHash: jdHash,
        source: "jd-ai",
        charged: true,
        remainingCredits: user.credits,
      });
    }

    // ── Free baseline ──
    // 1. Job description present → free, deterministic dictionary extraction.
    if (description) {
      const { skills = [] } = require("../services/extraction.service").extractRequirements(
        description
      );
      const keywords = skills
        .map((s) => ({
          name: s.name,
          importance: s.importance >= 4 ? "must_have" : "nice_to_have",
        }))
        .sort((a, b) =>
          a.importance === b.importance ? 0 : a.importance === "must_have" ? -1 : 1
        );
      return res.json({ keywords, source: "jd" });
    }

    // 2. Title only → cheap, cached AI inference of typical role keywords.
    if (title) {
      const { keywords = [] } = await require("../services/ai.service").inferRoleKeywords(title, {
        userId: req.user.id,
      });
      return res.json({ keywords, source: "title" });
    }

    // 3. Nothing to work with.
    return res.json({ keywords: [], source: "none" });
  } catch (error) {
    console.error("Job Keywords Error:", error);
    // Guidance feature — degrade gracefully rather than blocking the builder.
    // (Credit deduction happens only after a successful AI call above, so an
    // error here never leaves the user charged for nothing.)
    return res.json({ keywords: [], source: "none" });
  }
};

// @desc    Live keyword-coverage tracker for the CV builder (free, no AI).
//          Matches the user's skills/bullets against the job keywords using the
//          synonym + fuzzy normalizer so the score is trustworthy.
// @route   POST /api/ai/keyword-coverage
// @access  Private
const getKeywordCoverage = async (req, res) => {
  const { keywords, text, skills } = req.body || {};
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return res.json({ results: [], covered: 0, total: 0, mustHaveCovered: 0, mustHaveTotal: 0 });
  }
  try {
    const coverage = require("../services/skillNormalizer.service").computeKeywordCoverage(
      keywords,
      { text: text || "", skills: Array.isArray(skills) ? skills : [] }
    );
    return res.json(coverage);
  } catch (error) {
    console.error("Keyword Coverage Error:", error);
    return res.json({ results: [], covered: 0, total: 0, mustHaveCovered: 0, mustHaveTotal: 0 });
  }
};

module.exports = {
  generateApplication,
  generateBullets,
  getJobKeywords,
  getKeywordCoverage,
  generateSkills,
};
