const {
  generateOptimizedContent,
  generateInterviewQuestions,
  resolveTextModel,
} = require("../services/ai.service");
const Application = require("../models/Application");
const Resume = require("../models/Resume");
const Job = require("../models/Job");
const subscription = require("../services/subscription.service");
const settingsService = require("../services/settings.service");

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
        model: resolveTextModel(req.user), // tier-based: paid/agent → gpt-4o, free → gpt-4o-mini
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

// ── ApplyRight Suggested Summary tones ──
// Free users get only the first tone (Professional) generated for real; the rest
// are shown as locked, blurred upsell teasers. Paid users get all of them.
// Order matters: the first entry is the free tone.
const SUMMARY_TONES = [
  {
    key: "professional",
    label: "Professional",
    guidance: "Balanced, formal, classic resume summary.",
  },
  {
    key: "results",
    label: "Results-Driven",
    guidance:
      "Lead with measurable impact and achievements; use only numbers present or clearly implied in the CV, never invented.",
  },
  { key: "concise", label: "Concise", guidance: "Punchy and tight — 2 sentences maximum." },
  {
    key: "leadership",
    label: "Leadership",
    guidance:
      "Emphasize ownership, scope, and leading people/initiatives — only where the history supports it.",
  },
  {
    key: "careerChanger",
    label: "Career-Changer",
    guidance: "Bridge the candidate's past experience to the target role via transferable skills.",
  },
  {
    key: "warm",
    label: "Warm / Approachable",
    guidance: "Personable, human tone while staying professional.",
  },
];

// Blurred filler shown behind the lock for a free user's locked tones. No real
// AI text is generated for locked tones.
const LOCKED_SUMMARY_TEASER =
  "A polished, recruiter-ready summary written in this tone — tailored to your experience, highlighting your strongest, most relevant value in a way that makes hiring managers want to keep reading.";

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
const generateAtsSuggestions = async ({ role, context, targetJob, draftId, userId, model }) => {
  const aiService = require("../services/ai.service");
  const keywords = await resolveJobKeywords({ draftId, userId, targetJob });
  const ats = await aiService.generateBulletPoints(role, context, "experience", targetJob, {
    mode: "ats",
    keywords,
    count: PAID_ATS_SUGGESTIONS,
    model,
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
      const suggestions = await aiService.generateBulletPoints(role, context, type, targetJob, {
        model: resolveTextModel(req.user),
      });
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
        model: resolveTextModel(req.user),
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
    const ai = await aiService.generateBulletPoints(role, context, "experience", "", {
      model: resolveTextModel(req.user),
    });
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
        model: resolveTextModel(req.user),
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

// @desc    ApplyRight Suggested Summary — professional-summary variations in
//          different tones. Free users get ONLY the first tone (Professional)
//          generated for real; the rest come back as locked blurred teasers.
//          Paid users get every tone. Grounded in the candidate's CV (no JD).
// @route   POST /api/ai/generate-summaries
// @access  Private
const generateSummaries = async (req, res) => {
  const { role, context } = req.body;

  if (!context) {
    return res.status(400).json({ message: "Please provide some candidate context." });
  }

  try {
    const aiService = require("../services/ai.service");
    const user = await require("../models/User").findById(req.user.id).select("plan subscription");
    const isPaid = subscription.isPaidActive(user);

    // Free users: generate only the first tone (cheap). Paid: all tones.
    const tonesToGenerate = isPaid ? SUMMARY_TONES : SUMMARY_TONES.slice(0, 1);
    const generated = await aiService.generateSummaries(role, context, tonesToGenerate, {
      model: resolveTextModel(req.user),
    });
    const byKey = Object.fromEntries((generated || []).map((g) => [g.key, g.summary]));

    // Build the full ordered tone list; lock everything past the free tone for
    // free users (blurred teaser text, no real generation leaked).
    const tones = SUMMARY_TONES.map((t, idx) => {
      const locked = !isPaid && idx > 0;
      return {
        key: t.key,
        label: t.label,
        text: locked ? LOCKED_SUMMARY_TEASER : byKey[t.key] || "",
        locked,
      };
    });

    // If the one free tone failed to generate, surface an error rather than an
    // empty modal.
    if (!isPaid && !tones[0].text) {
      return res.status(502).json({ message: "Couldn't generate a summary. Please try again." });
    }

    return res.json({ isPaid, tones });
  } catch (error) {
    console.error("Summary Gen Error:", error);
    return res.status(500).json({ message: "Failed to generate summaries" });
  }
};

// @desc    Generate categorized skills from profile context
// @route   POST /api/ai/generate-skills
// @access  Private
// Deterministic "Best for this role": of the generated skills, which ones align
// with the target job's keywords (synonym + fuzzy match via the normalizer — no
// AI call, no cost). Returns the matching generated skill NAMES. Empty when there
// is no job description to rank against, which drives the "add a target job" UI.
const scoreBestForRole = (skillNames, { description = "", aiKeywords = [] } = {}) => {
  if (!Array.isArray(skillNames) || skillNames.length === 0) return [];

  const { compareSkills, normalizeSkill } = require("../services/skillNormalizer.service");

  // Prefer the richer cached AI keywords; else derive deterministically from the
  // JD text (same extraction the free keyword baseline uses).
  let jdKeywords =
    Array.isArray(aiKeywords) && aiKeywords.length
      ? aiKeywords
      : description
        ? require("../services/extraction.service")
            .extractRequirements(description)
            .skills.map((s) => ({
              name: s.name,
              importance: s.importance >= 4 ? "must_have" : "nice_to_have",
            }))
        : [];
  if (!jdKeywords.length) return [];

  // compareSkills(candidate, required): `matched` are JD keywords that were found
  // among the generated skills; `matchedWith` (fuzzy) or `name` (direct) is the
  // generated skill's canonical form.
  const cmp = compareSkills(skillNames, jdKeywords);
  const matchedCanon = new Set(
    (cmp.matched || [])
      .map((m) => (m.matchedWith || m.name || "").toLowerCase())
      .filter(Boolean)
  );
  return skillNames.filter((n) => matchedCanon.has(normalizeSkill(n).canonical.toLowerCase()));
};

const generateSkills = async (req, res) => {
  const { education, experience, projects, targetJob, draftId } = req.body;

  try {
    const SKILLS_COST = (await settingsService.getCreditCosts()).GENERATE_SKILLS;
    const user = await require("../models/User").findById(req.user.id);
    // Paid tiers get the richer output (STAR talking points) and skip the charge.
    const isPaid = subscription.isPaidActive(user);

    // Load the draft (when saved) so the generation can be cached against the
    // exact profile inputs — re-opening the modal or re-clicking then returns the
    // same set for free instead of re-charging and re-hitting the AI.
    let draft = null;
    if (draftId && draftId !== "new") {
      const found = await require("../models/DraftCV").findById(draftId);
      if (found && found.userId.toString() === req.user.id) draft = found;
    }

    // Hash of everything the generation depends on (whitespace/case-insensitive
    // on the JD so trivial edits don't bust the cache).
    const inputHash = require("crypto")
      .createHash("sha256")
      .update(
        JSON.stringify({
          education: education || [],
          experience: experience || [],
          projects: projects || [],
          targetJob: (targetJob || "").trim().toLowerCase().replace(/\s+/g, " "),
        })
      )
      .digest("hex");

    // Cache hit → free, no charge, no AI call.
    if (
      draft?.skillsGenCache?.hash === inputHash &&
      Array.isArray(draft.skillsGenCache.suggestions)
    ) {
      return res.json({
        suggestions: draft.skillsGenCache.suggestions,
        bestForRole: draft.skillsGenCache.bestForRole || [],
        isPaid,
        fromCache: true,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    // Verify credits before spending the AI call (free users only; paid skip).
    if (!isPaid && subscription.availableCredits(user) < SKILLS_COST) {
      return res.status(403).json({
        message: "Insufficient credits",
        code: "INSUFFICIENT_CREDITS",
        required: SKILLS_COST,
        current: subscription.availableCredits(user),
      });
    }

    const suggestions = await require("../services/ai.service").generateSkillsFromContext(
      education || [],
      experience || [],
      projects || [],
      targetJob || "",
      isPaid,
      { model: resolveTextModel(req.user) }
    );

    // Deterministic best-for-role set (prefers cached richer JD keywords).
    const allNames = [];
    (suggestions || []).forEach((g) => (g.skills || []).forEach((s) => allNames.push(s)));
    const bestForRole = scoreBestForRole(allNames, {
      description: targetJob || "",
      aiKeywords: draft?.targetJob?.aiKeywords || [],
    });

    // Charge (or skip for an active paid tier) BEFORE caching, so a failed charge
    // never leaves a cached result the user can re-fetch for free.
    const charge = await subscription.chargeOrSkip(user, SKILLS_COST, {
      type: "usage",
      description: "AI Skills Generation users profile context",
    });
    if (charge.insufficient) {
      return res.status(403).json({
        message: "Insufficient credits",
        code: "INSUFFICIENT_CREDITS",
        required: SKILLS_COST,
        current: subscription.availableCredits(user),
      });
    }

    // Persist the cache on the draft so re-opens/re-clicks are free.
    if (draft) {
      draft.skillsGenCache = { hash: inputHash, suggestions, bestForRole };
      draft.markModified("skillsGenCache");
      await draft.save();
    }

    res.json({
      suggestions,
      bestForRole,
      isPaid,
      fromCache: false,
      charged: charge.charged,
      remainingCredits: subscription.availableCredits(user),
    });
  } catch (error) {
    console.error("Skills Gen Error:", error);
    res.status(500).json({ message: "Failed to generate skills" });
  }
};

// Paid "Find more keywords" cost lives in config/creditCosts.js
// (GENERATE_JD_KEYWORDS) and is resolved per-request via getCreditCosts() inside
// getJobKeywords. The frontend mirror is applyright-frontend/src/lib/credits.js.

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
      const JD_KEYWORDS_COST = (await settingsService.getCreditCosts()).GENERATE_JD_KEYWORDS;
      const User = require("../models/User");
      const user = await User.findById(req.user.id);
      // Everyone spends credits now; paid tiers draw from their allowance first.
      if (subscription.availableCredits(user) < JD_KEYWORDS_COST) {
        return res.status(403).json({
          message: "Insufficient credits",
          code: "INSUFFICIENT_CREDITS",
          required: JD_KEYWORDS_COST,
          current: subscription.availableCredits(user),
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
          current: subscription.availableCredits(user),
        });
      }

      return res.json({
        keywords,
        aiKeywordsHash: jdHash,
        source: "jd-ai",
        charged: charge.charged,
        remainingCredits: subscription.availableCredits(user),
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

// @desc    Rewrite a professional summary into a tighter, shorter version.
//          No CV grounding — it only compresses the given text. Charges 1 credit,
//          but only AFTER the AI produces the rewrite (an AI outage 503s with no
//          charge). Mirrors the essential/grade endpoints' credit + AI handling.
// @route   POST /api/ai/tighten-summary
// @access  Private
const tightenSummary = async (req, res) => {
  const { text } = req.body || {};

  // Validate: non-empty string, reasonable length.
  if (typeof text !== "string" || text.trim().length < 20) {
    return res
      .status(400)
      .json({ message: "Provide a professional summary of at least 20 characters to tighten." });
  }
  if (text.trim().length > 2000) {
    return res
      .status(400)
      .json({ message: "Summary is too long to tighten (max ~2000 characters)." });
  }

  try {
    const aiService = require("../services/ai.service");
    const user = req.user; // set by `protect`

    const COST = (await settingsService.getCreditCosts()).TIGHTEN_SUMMARY;

    // AI FIRST — if no provider is configured, this throws AI_UNAVAILABLE and we
    // 503 below WITHOUT charging (the deduction only happens after success).
    const tightened = await aiService.tightenSummary(text, {
      userId: req.user.id,
      model: resolveTextModel(req.user),
    });

    // Charge 1 credit atomically (balance-guarded). Paid tiers draw from their
    // per-period allowance first via chargeOrSkip — same mechanism as the other
    // text endpoints (see generateApplicationEssential / generateSkills).
    const charge = await subscription.chargeOrSkip(user, COST, {
      type: "usage",
      description: "AI tighten professional summary",
    });
    if (charge.insufficient) {
      return res.status(403).json({
        message: "Insufficient credits",
        code: "INSUFFICIENT_CREDITS",
        required: COST,
        current: subscription.availableCredits(user),
      });
    }

    return res.json({ tightened, remainingCredits: subscription.availableCredits(user) });
  } catch (error) {
    // AI unavailable → 503, no charge (the deduction is after the AI call).
    if (error?.name === "AIUnavailableError" || error?.code === "AI_UNAVAILABLE") {
      return res.status(503).json({
        message:
          "AI service is temporarily unavailable. You have not been charged. Please try again later.",
        code: "AI_UNAVAILABLE",
      });
    }
    console.error("Tighten Summary Error:", error.message);
    return res.status(500).json({ message: "Failed to tighten summary" });
  }
};

module.exports = {
  generateApplication,
  generateBullets,
  revealAtsTaste,
  generateSummaries,
  getJobKeywords,
  getKeywordCoverage,
  generateSkills,
  tightenSummary,
};
