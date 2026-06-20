const { generateOptimizedContent, generateInterviewQuestions } = require("../services/ai.service");
const Application = require("../models/Application");
const Resume = require("../models/Resume");
const Job = require("../models/Job");
const subscription = require("../services/subscription.service");

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

    // Check Usage Limits ONLY if creating a NEW application (active paid tier is
    // unlimited; honors subscription expiry).
    if (!application && !subscription.isPaidActive(req.user)) {
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

// ── Two-tier work-history suggestions (free "AI" vs paid "ApplyRight ATS") ──
// Free users: 6 generic (JD-blind) suggestions on the left, pick up to 3, max 3
// bullets per role. The right "ApplyRight ATS" column is a BLURRED TEASER only —
// no ATS AI call is made for free users, so free clicks stay cheap. Paid users:
// 10 real ATS suggestions (JD-keyword targeted, truth-grounded), pick all.
const FREE_AI_SUGGESTIONS = 6; // generic suggestions shown to free users
const FREE_SELECT_LIMIT = 3; // free users can apply at most this many
const FREE_BULLET_LIMIT = 3; // free users limited to this many bullets per role
const PAID_ATS_SUGGESTIONS = 10; // ATS suggestions generated for paid users

// Plausible-looking filler shown (blurred) in the locked ApplyRight ATS column
// as an upsell teaser. No real ATS text is generated for free users at all.
const LOCKED_BULLET_PLACEHOLDERS = [
  "Spearheaded a cross-functional effort that streamlined daily operations and improved turnaround time.",
  "Partnered with stakeholders to close process gaps and deliver measurable quality improvements.",
  "Owned end-to-end delivery of a key workstream while balancing competing priorities under deadline.",
  "Introduced practical improvements that reduced rework and lifted overall team output.",
  "Drove measurable gains by aligning daily execution with the priorities hiring teams screen for.",
  "Translated hands-on results into the exact terminology recruiters search for in this role.",
];

// Resolve the target-job keyword set for ATS suggestions, reusing existing
// infrastructure and never charging here (extraction is charged in
// getJobKeywords): 1) the AI keywords already cached on the draft, else
// 2) free deterministic dictionary extraction from the JD text.
const resolveJobKeywords = async ({ draftId, userId, targetJob }) => {
  if (draftId && draftId !== "new") {
    try {
      const draft = await require("../models/DraftCV")
        .findById(draftId)
        .select("userId targetJob");
      if (
        draft &&
        draft.userId.toString() === userId &&
        Array.isArray(draft.targetJob?.aiKeywords) &&
        draft.targetJob.aiKeywords.length > 0
      ) {
        return draft.targetJob.aiKeywords;
      }
    } catch (_) {
      /* fall through to deterministic extraction */
    }
  }

  const desc = (typeof targetJob === "string" ? targetJob : targetJob?.description || "").trim();
  if (desc) {
    const { skills = [] } = require("../services/extraction.service").extractRequirements(desc);
    return skills.map((s) => ({
      name: s.name,
      importance: s.importance >= 4 ? "must_have" : "nice_to_have",
    }));
  }
  return [];
};

// Generate the real, JD-keyword-targeted ApplyRight ATS suggestions for one role.
// Shared by paid generation (generateBullets) and the free user's explicit
// one-time reveal (revealAtsTaste). `real` is false when the AI service returned
// its "Error generating…" sentinel (it does that instead of throwing).
const generateAtsSuggestions = async ({ role, context, targetJob, draftId, userId }) => {
  const aiService = require("../services/ai.service");
  const keywords = await resolveJobKeywords({ draftId, userId, targetJob });
  const ats = await aiService.generateBulletPoints(role, context, "experience", targetJob, {
    mode: "ats",
    keywords,
    count: PAID_ATS_SUGGESTIONS,
  });
  const list = Array.isArray(ats) ? ats : [];
  const real = list.length > 0 && !/^Error generating/i.test(list[0] || "");
  return { ats: list, keywords, real };
};

// @desc    Generate bullet points or summary
// @route   POST /api/ai/generate-bullets
// @access  Private
const generateBullets = async (req, res) => {
  const { role, context, type, targetJob, draftId } = req.body;

  // Basic validation
  if (!role && !context) {
    return res.status(400).json({ message: "Please provide role/title and some context." });
  }

  try {
    const aiService = require("../services/ai.service");

    // Summary & Project keep the original simple contract (no two-tier UI).
    if (type !== "experience") {
      const suggestions = await aiService.generateBulletPoints(role, context, type, targetJob);
      return res.json({ suggestions, lockedCount: 0 });
    }

    // ── Work history: two-tier (AI vs ApplyRight ATS) ──
    const User = require("../models/User");
    const user = await User.findById(req.user.id).select("plan subscription atsSuggestions");
    const isPaid = subscription.isPaidActive(user); // honors subscription expiry

    // Paid: full ApplyRight ATS, unlimited selection.
    if (isPaid) {
      const { ats, keywords } = await generateAtsSuggestions({
        role,
        context,
        targetJob,
        draftId,
        userId: req.user.id,
      });
      return res.json({
        isPaid: true,
        ats: { title: "ApplyRight ATS", suggestions: ats, locked: false },
        limits: { selectMax: null, bulletMax: null },
        keywordCount: keywords.length,
      });
    }

    // Free user. The generic "AI suggestions" are always real (cheap). The
    // ApplyRight ATS column starts as a BLURRED teaser — the REAL suggestions are
    // generated only when the user explicitly clicks "Reveal" (POST
    // /ai/reveal-ats-taste), which is also where the one-time taste is consumed.
    // `atsTasteAvailable` tells the client to show the "Reveal" button (still
    // available) vs the upgrade CTA (already used).
    const ai = await aiService.generateBulletPoints(role, context, "experience", "");
    const aiTrimmed = (Array.isArray(ai) ? ai : []).slice(0, FREE_AI_SUGGESTIONS);
    const atsTeaser = Array.from(
      { length: PAID_ATS_SUGGESTIONS },
      (_, i) => LOCKED_BULLET_PLACEHOLDERS[i % LOCKED_BULLET_PLACEHOLDERS.length]
    );
    return res.json({
      isPaid: false,
      atsTasteAvailable: !user?.atsSuggestions?.freeTasteUsed,
      ai: { title: "AI suggestions", suggestions: aiTrimmed },
      ats: { title: "ApplyRight ATS", suggestions: atsTeaser, locked: true },
      limits: { selectMax: FREE_SELECT_LIMIT, bulletMax: FREE_BULLET_LIMIT },
    });
  } catch (error) {
    console.error("Bullet Gen Error:", error);
    res.status(500).json({ message: "Failed to generate suggestions" });
  }
};

// @desc    Reveal the free user's ONE-TIME real ApplyRight ATS suggestions for a
//          role. Triggered explicitly by the user (a "Reveal" button) so they
//          choose to spend their trial. The taste is claimed ATOMICALLY before
//          generating, so the real ATS runs at most once per user, ever; the
//          claim is refunded if generation fails so they can retry.
// @route   POST /api/ai/reveal-ats-taste
// @access  Private
const revealAtsTaste = async (req, res) => {
  const { role, context, targetJob, draftId } = req.body;

  if (!role && !context) {
    return res.status(400).json({ message: "Please provide role/title and some context." });
  }

  try {
    const User = require("../models/User");

    // Claim the one-time taste BEFORE spending any tokens.
    const claimed = await User.findOneAndUpdate(
      { _id: req.user.id, "atsSuggestions.freeTasteUsed": { $ne: true } },
      { $set: { "atsSuggestions.freeTasteUsed": true } }
    );
    if (!claimed) {
      return res
        .status(409)
        .json({ code: "TASTE_USED", message: "Your free ApplyRight ATS preview has been used." });
    }

    try {
      const { ats, real } = await generateAtsSuggestions({
        role,
        context,
        targetJob,
        draftId,
        userId: req.user.id,
      });
      if (!real) {
        // Refund so the user can try again.
        await User.updateOne(
          { _id: req.user.id },
          { $set: { "atsSuggestions.freeTasteUsed": false } }
        );
        return res
          .status(502)
          .json({ message: "Couldn't generate ATS suggestions. Please try again." });
      }
      return res.json({
        taste: true,
        ats: { title: "ApplyRight ATS", suggestions: ats, locked: false },
        limits: { selectMax: FREE_SELECT_LIMIT, bulletMax: FREE_BULLET_LIMIT },
      });
    } catch (err) {
      await User.updateOne(
        { _id: req.user.id },
        { $set: { "atsSuggestions.freeTasteUsed": false } }
      );
      throw err;
    }
  } catch (error) {
    console.error("Reveal ATS Taste Error:", error);
    return res.status(500).json({ message: "Failed to reveal ATS suggestions" });
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

    // Active paid tiers get unlimited text prep — skip the balance check.
    if (!subscription.isPaidActive(user) && user.credits < SKILLS_COST) {
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

    // Charge (or skip for an active paid tier).
    const charge = await subscription.chargeOrSkip(user, SKILLS_COST, {
      type: "usage",
      description: "AI Skills Generation users profile context",
    });
    if (charge.insufficient) {
      return res.status(403).json({
        message: "Insufficient credits",
        code: "INSUFFICIENT_CREDITS",
        required: SKILLS_COST,
        current: user.credits,
      });
    }

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
      // Active paid tiers get unlimited text prep — skip the balance check.
      if (!subscription.isPaidActive(user) && user.credits < JD_KEYWORDS_COST) {
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

      // Charge (or skip for an active paid tier).
      const charge = await subscription.chargeOrSkip(user, JD_KEYWORDS_COST, {
        type: "usage",
        description: "AI job keyword extraction (CV builder)",
      });
      if (charge.insufficient) {
        return res.status(403).json({
          message: "Insufficient credits",
          code: "INSUFFICIENT_CREDITS",
          required: JD_KEYWORDS_COST,
          current: user.credits,
        });
      }

      return res.json({
        keywords,
        aiKeywordsHash: jdHash,
        source: "jd-ai",
        charged: charge.charged,
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
  revealAtsTaste,
  getJobKeywords,
  getKeywordCoverage,
  generateSkills,
};
