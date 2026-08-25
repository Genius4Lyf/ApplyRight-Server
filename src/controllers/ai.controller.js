const {
  generateOptimizedContent,
  generateInterviewQuestions,
  resolveTextModel,
} = require("../services/ai.service");
const Application = require("../models/Application");
const Resume = require("../models/Resume");
const Job = require("../models/Job");
const subscription = require("../services/subscription.service");
const langService = require("../services/language.service");
const settingsService = require("../services/settings.service");
const modelSelection = require("../services/modelSelection.service");
const { TRANSACTION_TYPES } = require("../config/transactionTypes");

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
      const draft = await require("../models/DraftCV").findById(draftId).select("userId targetJob");
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
const generateAtsSuggestions = async ({
  role,
  context,
  targetJob,
  draftId,
  userId,
  model,
  lang,
}) => {
  const aiService = require("../services/ai.service");
  const keywords = await resolveJobKeywords({ draftId, userId, targetJob });
  const ats = await aiService.generateBulletPoints(role, context, "experience", targetJob, {
    mode: "ats",
    keywords,
    count: PAID_ATS_SUGGESTIONS,
    model,
    lang,
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
    // DOCUMENT action — bullets are CV content, so they follow the CV's own
    // language (falling back to the request language for CVs that have none).
    const docLang = await langService.docLangById(draftId, req);

    // Summary & Project keep the original simple contract (no two-tier UI).
    if (type !== "experience") {
      const suggestions = await aiService.generateBulletPoints(role, context, type, targetJob, {
        model: resolveTextModel(req.user),
        lang: docLang,
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
        lang: docLang,
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
      lang: docLang,
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
        // DOCUMENT action — ATS bullets are CV content.
        lang: await langService.docLangById(draftId, req),
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
      // DOCUMENT action — the summary is CV content.
      lang: await langService.docLangById(req.body?.draftId, req),
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
const scoreBestForRole = (
  skillNames,
  { description = "", aiKeywords = [], roleBrief = null } = {}
) => {
  if (!Array.isArray(skillNames) || skillNames.length === 0) return [];

  const { compareSkills, normalizeSkill } = require("../services/skillNormalizer.service");

  // Prefer the richer cached AI keywords; else derive deterministically from the
  // JD text (same extraction the free keyword baseline uses).
  const briefKeywords = [
    ...(Array.isArray(roleBrief?.mustHaves) ? roleBrief.mustHaves : []),
    ...(Array.isArray(roleBrief?.niceToHaves) ? roleBrief.niceToHaves : []),
  ];
  let jdKeywords = briefKeywords.length
    ? briefKeywords
    : Array.isArray(aiKeywords) && aiKeywords.length
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
    (cmp.matched || []).map((m) => (m.matchedWith || m.name || "").toLowerCase()).filter(Boolean)
  );
  return skillNames.filter((n) => matchedCanon.has(normalizeSkill(n).canonical.toLowerCase()));
};

// Re-key the interview ledger (draft.coachEvidence, keyed by _sortId) into the SAME
// bracket-index space the skills prompt uses for experience/projects, so a citation can
// point at a profile entry the model can actually see.
//
// Order matters and must match the prompt's own indexing: the prompt numbers the arrays
// it is handed, so we resolve against those same arrays rather than against the draft.
const interviewEvidenceForSkills = (draft, experience = [], projects = []) => {
  const ledger = draft?.coachEvidence?.toObject
    ? draft.coachEvidence.toObject()
    : draft?.coachEvidence || {};
  if (!ledger || typeof ledger !== "object") return [];

  const indexOf = (list, sortId) =>
    (Array.isArray(list) ? list : []).findIndex(
      (row) => String(row?._sortId || "") === String(sortId)
    );

  const out = [];
  Object.entries(ledger).forEach(([sortId, bucket]) => {
    const evidence = Array.isArray(bucket?.evidence) ? bucket.evidence : [];
    if (!evidence.length) return;

    let type = "experience";
    let refIndex = indexOf(experience, sortId);
    if (refIndex < 0) {
      refIndex = indexOf(projects, sortId);
      type = "project";
    }
    // The entry was deleted after its interview. Dropping it is correct: an index we
    // cannot resolve would point the model at the wrong row.
    if (refIndex < 0) return;

    evidence.forEach((item) => {
      const claim = String(item?.claim || "").trim();
      const sourceQuote = String(item?.sourceQuote || "").trim();
      if (!claim || !sourceQuote) return;
      out.push({
        evidenceId: String(item?.id || ""),
        type,
        refIndex,
        claim,
        sourceQuote,
        tools: Array.isArray(item?.tools) ? item.tools.filter(Boolean).slice(0, 6) : [],
        requirementIds: Array.isArray(item?.requirementIds)
          ? item.requirementIds.filter(Boolean).slice(0, 6)
          : [],
      });
    });
  });
  return out.slice(0, 40);
};

// The skills-section gaps the scan already measured, read from the persisted scan rather
// than trusted from the client. Sanitised the way coach.controller sanitises its own
// keyword lists (strings, short, deduped, capped).
const scanMissingSkillKeywords = (draft) => {
  const scan = draft?.studioScan?.toObject ? draft.studioScan.toObject() : draft?.studioScan || {};
  const fromSection = (Array.isArray(scan?.sections) ? scan.sections : []).find(
    (section) => section?.key === "skills"
  )?.missingKeywords;
  const raw = [
    ...(Array.isArray(fromSection) ? fromSection : []),
    ...(Array.isArray(scan?.missingSkills) ? scan.missingSkills : []),
  ];
  const seen = new Set();
  const out = [];
  raw.forEach((entry) => {
    const name = String(typeof entry === "string" ? entry : entry?.name || "").trim();
    if (!name || name.length > 60) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out.slice(0, 10);
};

// How strongly the PROFILE backs a skill, 0-100. Pure and deterministic — no AI, no cost.
//
// scoreBestForRole answers "does this skill match the job?" and stays the MATCHER. It was
// also, accidentally, the whole ranker: a starred skill only ever meant "resembles a JD
// keyword", and every row was stamped evidenceStatus 'demonstrated' regardless of how much
// backed it. So a skill mentioned once in passing outranked one the user talked through in
// an interview, as long as it matched a keyword.
const evidenceStrength = (row) => {
  const interview = (row?.evidence || []).filter((item) => item?.fromInterview);
  const profile = (row?.evidence || []).filter((item) => !item?.fromInterview);

  let score = 0;
  // Named in their own words, server-verified against a real turn. The strongest signal
  // available, and the reason feeding the ledger into generation was worth doing.
  if (interview.length) score += 40;
  // Breadth: the same skill showing up across separate parts of a life is corroboration.
  const distinctSources = new Set(
    (row?.evidence || []).map((item) => `${item?.type}:${item?.refIndex}`)
  );
  score += Math.min(50, distinctSources.size * 25);
  // Recency: experience[0] is the most recent role, and recruiters read the top first.
  if (profile.some((item) => item.type === "experience" && item.refIndex === 0)) score += 15;
  // The user's own honesty rating, when they gave one. This is confirmationStatus's first
  // real consumer — it has been stored and read by nothing.
  if (row?.confirmationStatus === "direct") score += 10;
  else if (row?.confirmationStatus === "basic") score += 4;
  // Coursework is genuine evidence of a METHOD or a domain; for a TOOL it is much weaker
  // than having used it at work, and should not present as a headline strength.
  const onlyEducation =
    (row?.evidence || []).length > 0 && (row?.evidence || []).every((i) => i?.type === "education");
  if (onlyEducation) score -= 20;

  return Math.max(0, Math.min(100, score));
};

// How much the JOB wants it, 0-100.
const jobRelevance = (row, bestSet, requirementByName) => {
  const key = String(row?.name || "").toLowerCase();
  const requirement = requirementByName.get(key);
  if (requirement) return requirement.priority === "must_have" ? 100 : 60;
  return bestSet.has(key) ? 60 : 0;
};

// Honest status, replacing the flat 'demonstrated' stamp.
const evidenceStatusFor = (row) => {
  if ((row?.evidence || []).some((item) => item?.fromInterview)) return "confirmed";
  if (row?.confirmationStatus === "basic") return "basic_exposure";
  if ((row?.evidence || []).length) return "demonstrated";
  return "related";
};

const skillSourceLabel = (item, type, index) => {
  if (type === "experience") return [item?.title, item?.company].filter(Boolean).join(" at ");
  if (type === "project") return item?.title || `Project ${index + 1}`;
  return [item?.degree || item?.field, item?.school].filter(Boolean).join(" at ");
};

const skillReviewGroups = ({
  suggestions,
  bestForRole,
  roleBrief,
  targetJob,
  education,
  experience,
  projects,
  certifications = [],
  confirmationCandidates = [],
  // draft.skillDeclines — requirements the user has explicitly said they've never done.
  declinedSkills = [],
}) => {
  const sources = { education, experience, project: projects };
  const bestSet = new Set((bestForRole || []).map((name) => String(name).toLowerCase()));
  const rows = [];
  const seen = new Set();
  (suggestions || []).forEach((group, groupIndex) => {
    const details = new Map(
      (group.skillsDetailed || []).map((detail) => [
        String(detail?.name || "").toLowerCase(),
        detail,
      ])
    );
    (group.skills || []).forEach((name, skillIndex) => {
      const key = String(name || "")
        .trim()
        .toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      const detail = details.get(key) || {};
      // Interview citations join the profile evidence as first-class sources, flagged so
      // the UI (and evidenceStrength) can tell "you told me this" from "it's on your CV".
      const evidence = [...(detail.evidence || []), ...(detail.interviewEvidence || [])].map(
        (item) => ({
          ...item,
          sourceLabel:
            skillSourceLabel(sources[item.type]?.[item.refIndex], item.type, item.refIndex) ||
            `${item.type} ${item.refIndex + 1}`,
        })
      );
      const requirementIds = [
        ...new Set(
          (detail.interviewEvidence || []).flatMap((item) =>
            Array.isArray(item?.requirementIds) ? item.requirementIds : []
          )
        ),
      ];
      const row = {
        name: String(name).trim(),
        category: group.category || "Uncategorized",
        evidence,
        talkingPoint: detail.talkingPoint || "",
        explicitlyConfirmed: false,
        ...(requirementIds.length ? { requirementIds } : {}),
        reason: evidence[0]?.snippet || "Demonstrated in your CV.",
        rank: groupIndex * 20 + skillIndex,
      };
      row.evidenceStatus = evidenceStatusFor(row);
      row.evidenceStrength = evidenceStrength(row);
      rows.push(row);
    });
  });

  const hasJobDescription = Boolean(String(targetJob || "").trim() || roleBrief?.role);
  if (!hasJobDescription) {
    // No job to rank against, so evidence strength IS the ranking — "core" means most
    // strongly evidenced and most central, not "whatever the model listed first".
    const byStrength = [...rows].sort(
      (a, b) => b.evidenceStrength - a.evidenceStrength || a.rank - b.rank
    );
    const coreCount = Math.min(8, Math.max(4, Math.ceil(byStrength.length * 0.55)));
    return {
      mode: "profile",
      core: byStrength.slice(0, coreCount),
      additional: byStrength.slice(coreCount),
      confirmation: (confirmationCandidates || []).map((candidate) => ({
        ...candidate,
        evidence: (candidate.evidence || []).map((item) => ({
          ...item,
          sourceLabel:
            skillSourceLabel(sources[item.type]?.[item.refIndex], item.type, item.refIndex) ||
            `${item.type} ${item.refIndex + 1}`,
        })),
        explicitlyConfirmed: false,
        evidenceStatus: "plausible",
      })),
      gaps: [],
    };
  }

  const roleRequirements = Array.isArray(roleBrief?.requirements) ? roleBrief.requirements : [];
  // Name/alias → requirement, so relevance can distinguish a must-have from a nice-to-have
  // instead of treating every keyword match as equal.
  const requirementByName = new Map();
  roleRequirements.forEach((item) => {
    if (!item?.name) return;
    [item.name, ...(item.aliases || [])].forEach((alias) => {
      const key = String(alias || "")
        .trim()
        .toLowerCase();
      if (key && !requirementByName.has(key)) requirementByName.set(key, item);
    });
  });

  // "Best for this role" now means strong on BOTH axes — the job wants it AND the
  // candidate can actually show it — rather than "the name resembled a keyword".
  rows.forEach((row) => {
    row.jobRelevance = jobRelevance(row, bestSet, requirementByName);
    row.matchScore = Math.round(0.6 * row.jobRelevance + 0.4 * row.evidenceStrength);
  });
  const byScore = (a, b) => b.matchScore - a.matchScore || a.rank - b.rank;

  const important = rows.filter((row) => row.jobRelevance > 0).sort(byScore);
  const additional = rows.filter((row) => row.jobRelevance === 0).sort(byScore);
  const certificationRequirements = roleRequirements.filter(
    (item) => item?.name && item?.type === "certification"
  );
  // Anything the user has explicitly told us they've never done. It stops being offered as
  // something to confirm — being asked again about a "no" is the fastest way to feel
  // unheard. It is NOT hidden from the gaps list: an honest gap is still worth knowing
  // about, it just isn't a question any more.
  const declined = new Set(
    (declinedSkills || [])
      .map((row) => String(typeof row === "string" ? row : row?.name || "").toLowerCase())
      .filter(Boolean)
  );
  const typedRequirements = roleRequirements.filter(
    (item) =>
      item?.name &&
      item?.type !== "responsibility" &&
      // Credentials have their own first-class DraftCV.certifications section. Showing
      // them as confirmable skill rows lets a real certificate (or a vague JD phrase
      // such as "technical certifications") leak into skills[].
      item?.type !== "certification"
  );
  const matchedRequirements = new Set();
  typedRequirements.forEach((requirement) => {
    const terms = [requirement.name, ...(requirement.aliases || [])].map((term) =>
      String(term || "").toLowerCase()
    );
    if (rows.some((row) => terms.some((term) => term && row.name.toLowerCase().includes(term)))) {
      matchedRequirements.add(requirement.id);
    }
  });

  const searchableSources = Object.entries(sources).flatMap(([type, list]) =>
    (list || []).map((item, refIndex) => ({
      type,
      refIndex,
      item,
      label: skillSourceLabel(item, type, refIndex),
      text: [item?.title, item?.company, item?.degree, item?.field, item?.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    }))
  );
  const meaningfulTokens = (value) =>
    (
      String(value || "")
        .toLowerCase()
        .match(/[a-z0-9+#.]{4,}/g) || []
    ).filter(
      (token) =>
        !["with", "using", "experience", "strong", "skills", "ability", "knowledge"].includes(token)
    );
  const confirmation = (confirmationCandidates || []).map((candidate) => ({
    ...candidate,
    evidence: (candidate.evidence || []).map((item) => ({
      ...item,
      sourceLabel:
        skillSourceLabel(sources[item.type]?.[item.refIndex], item.type, item.refIndex) ||
        `${item.type} ${item.refIndex + 1}`,
    })),
    explicitlyConfirmed: false,
    evidenceStatus: "plausible",
  }));
  const gaps = [];
  typedRequirements
    .filter((requirement) => !matchedRequirements.has(requirement.id))
    .forEach((requirement) => {
      const signalTokens = meaningfulTokens(
        [...(requirement.proofSignals || []), ...(requirement.aliases || [])].join(" ")
      );
      const source = searchableSources
        .map((candidate) => ({
          ...candidate,
          score: signalTokens.filter((token) => candidate.text.includes(token)).length,
        }))
        .sort((a, b) => b.score - a.score)[0];
      const row = {
        name: requirement.name,
        category:
          {
            tool: "Tools & Software",
            technology: "Technologies",
            method: "Methods & Practices",
            domain: "Industry Knowledge",
            certification: "Certifications",
          }[requirement.type] || "Professional Skills",
        requirementId: requirement.id,
        requirementPriority: requirement.priority,
        explicitlyConfirmed: false,
        evidenceStatus: source?.score > 0 ? "plausible" : "not_demonstrated",
        reason:
          source?.score > 0
            ? `Your ${source.label || source.type} contains related activity, but does not explicitly prove this skill.`
            : "The employer asks for this, but it is not demonstrated in your CV.",
        evidence:
          source?.score > 0
            ? [
                {
                  type: source.type,
                  refIndex: source.refIndex,
                  sourceLabel: source.label,
                  snippet: String(source.item?.description || "").slice(0, 220),
                },
              ]
            : [],
      };
      // A declined requirement stays visible as an honest gap, but never as a question.
      const wasDeclined = declined.has(requirement.name.toLowerCase());
      if (wasDeclined) gaps.push({ ...row, evidenceStatus: "not_demonstrated", declined: true });
      else if (source?.score > 0) confirmation.push(row);
      else gaps.push(row);
    });

  // Credentials never become addable skill rows. Keep unmatched employer credentials
  // visible as honest requirements, while recognizing certificates already saved in the
  // draft's dedicated Certifications section.
  const savedCredentialNames = (certifications || []).map((item) =>
    String(typeof item === "string" ? item : item?.name || item?.title || "").toLowerCase()
  );
  certificationRequirements.forEach((requirement) => {
    const terms = [requirement.name, ...(requirement.aliases || [])]
      .map((term) => String(term || "").toLowerCase())
      .filter(Boolean);
    const alreadySaved = savedCredentialNames.some((saved) =>
      terms.some((term) => saved.includes(term) || term.includes(saved))
    );
    if (!alreadySaved) {
      gaps.push({
        name: requirement.name,
        category: "Certifications",
        requirementId: requirement.id,
        requirementPriority: requirement.priority,
        requirementKind: "certification",
        explicitlyConfirmed: false,
        evidenceStatus: "not_demonstrated",
        reason:
          "The employer requests this credential, but it is not in your Certifications section.",
        evidence: [],
      });
    }
  });

  return {
    mode: "job",
    important,
    additional,
    confirmation: confirmation
      .filter(
        (row, index, list) =>
          !seen.has(String(row.name || "").toLowerCase()) &&
          list.findIndex(
            (candidate) =>
              String(candidate.name || "").toLowerCase() === String(row.name || "").toLowerCase()
          ) === index
      )
      .slice(0, 6),
    gaps: gaps.slice(0, 8),
  };
};

const generateSkills = async (req, res) => {
  const { education, experience, projects, targetJob, draftId } = req.body;
  // Lazily required, matching the rest of this controller (avoids a circular import).
  const aiService = require("../services/ai.service");

  try {
    const user = await require("../models/User").findById(req.user.id);
    // Paid tiers get the richer output (STAR talking points). Charging is tier-aware below.
    const isPaid = subscription.isPaidActive(user);

    // Load the draft (when saved) so the generation can be cached against the
    // exact profile inputs — re-opening the modal or re-clicking then returns the
    // same set for free instead of re-charging and re-hitting the AI.
    let draft = null;
    if (draftId && draftId !== "new") {
      const found = await require("../models/DraftCV").findById(draftId);
      if (found && found.userId.toString() === req.user.id) draft = found;
    }

    // Resolve + gate the session model, priced by tier (flagship skills cost more).
    const {
      modelId,
      tier,
      cost: SKILLS_COST,
    } = await modelSelection.resolveForAction({
      action: "GENERATE_SKILLS",
      sessionModelId: req.body?.model,
      draft,
      user,
    });

    // What the user CONFIRMED in Aria's work-history interviews, re-keyed from the ledger
    // (which is keyed by _sortId) into the SAME bracket-index space the skills prompt uses
    // for experience/projects. Until now none of this reached skills generation at all:
    // everything a user confirmed while building their CV was discarded before their skills
    // were written.
    const interviewEvidence = interviewEvidenceForSkills(draft, experience, projects);

    // The gaps the scan already measured. Sourced SERVER-side from the persisted scan
    // rather than trusted from the client — the Studio "fix skills" flow displayed these
    // and then called a generator that had never heard of them.
    const missingKeywords = scanMissingSkillKeywords(draft);

    // Hash of everything the generation depends on (whitespace/case-insensitive
    // on the JD so trivial edits don't bust the cache).
    const inputHash = require("crypto")
      .createHash("sha256")
      .update(
        JSON.stringify({
          // Bump when the extraction/category contract changes so stale layouts are not
          // served forever. Model is part of the identity because a user explicitly
          // choosing Claude must not receive a cached Standard-model result.
          //
          // 4: skills became career-stage aware and now consume the interview ledger and
          // the scan's missing keywords. WITHOUT these three in the hash, finishing an
          // interview or changing career stage would serve the old ledger-blind result
          // forever — the fix would look inert rather than wrong, which is worse.
          skillsGenSchema: 4,
          modelId,
          education: education || [],
          experience: experience || [],
          projects: projects || [],
          certifications: draft?.certifications || [],
          targetJob: (targetJob || "").trim().toLowerCase().replace(/\s+/g, " "),
          briefHash: draft?.targetJob?.briefHash || "",
          careerStage: aiService.resolveCareerStage({ stage: req.body?.stage, draft }),
          interviewEvidence: interviewEvidence.map((item) => item.evidenceId).sort(),
          missingKeywords: [...missingKeywords].sort(),
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
        reviewGroups:
          draft.skillsGenCache.reviewGroups ||
          skillReviewGroups({
            suggestions: draft.skillsGenCache.suggestions,
            bestForRole: draft.skillsGenCache.bestForRole || [],
            roleBrief: draft?.targetJob?.brief || null,
            targetJob,
            education: education || [],
            experience: experience || [],
            projects: projects || [],
            certifications: draft?.certifications || [],
            declinedSkills: draft?.skillDeclines || [],
          }),
        isPaid,
        fromCache: true,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    // Verify credits before spending the AI call — only when it will actually meter
    // (a paid LIGHT skills gen is free/unlimited; flagship always meters).
    const willMeter = tier === "flagship" || !isPaid;
    if (willMeter && subscription.availableCredits(user) < SKILLS_COST) {
      return res.status(403).json({
        message: "Insufficient credits",
        code: "INSUFFICIENT_CREDITS",
        required: SKILLS_COST,
        current: subscription.availableCredits(user),
      });
    }

    const generated = await require("../services/ai.service").generateSkillsFromContext(
      education || [],
      experience || [],
      projects || [],
      targetJob || "",
      isPaid,
      // Route through the selected model (multi-provider dispatcher).
      // DOCUMENT action — skills are CV content, so they follow the CV's language.
      {
        modelId,
        brief: draft?.targetJob?.brief?.toObject
          ? draft.targetJob.brief.toObject()
          : draft?.targetJob?.brief || null,
        certifications: draft?.certifications || [],
        interviewEvidence,
        missingKeywords,
        stage: aiService.resolveCareerStage({ stage: req.body?.stage, draft }),
        meta: {
          userId: req.user.id,
          operation: "generateSkills",
          lang: langService.docLang(draft, req),
        },
      }
    );
    const suggestions = Array.isArray(generated) ? generated : generated?.suggestions || [];
    const confirmationCandidates = Array.isArray(generated)
      ? []
      : generated?.confirmationCandidates || [];
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      return res.status(502).json({
        message:
          "Aria couldn't find enough supported skills yet. Add more detail to your experience or projects and try again.",
      });
    }

    // Deterministic best-for-role set (prefers cached richer JD keywords).
    const allNames = [];
    (suggestions || []).forEach((g) => (g.skills || []).forEach((s) => allNames.push(s)));
    const bestForRole = scoreBestForRole(allNames, {
      description: targetJob || "",
      aiKeywords: draft?.targetJob?.aiKeywords || [],
      roleBrief: draft?.targetJob?.brief || null,
    });
    const reviewGroups = skillReviewGroups({
      suggestions,
      bestForRole,
      roleBrief: draft?.targetJob?.brief || null,
      targetJob,
      education: education || [],
      experience: experience || [],
      projects: projects || [],
      certifications: draft?.certifications || [],
      declinedSkills: draft?.skillDeclines || [],
      confirmationCandidates,
    });

    // Charge BEFORE caching, so a failed charge never leaves a cached result the user can
    // re-fetch for free. Tier-aware: flagship always meters; light is free on a paid plan.
    const charge = await modelSelection.chargeForModel(user, SKILLS_COST, tier, {
      type: TRANSACTION_TYPES.GENERATE_SKILLS,
      description: "Aria skills",
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
      draft.skillsGenCache = { hash: inputHash, suggestions, bestForRole, reviewGroups };
      draft.markModified("skillsGenCache");
      await draft.save();
    }

    res.json({
      suggestions,
      bestForRole,
      reviewGroups,
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
        lang: req.lang,
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
        lang: req.lang,
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
      // DOCUMENT action — the summary is CV content.
      lang: await langService.docLangById(req.body?.draftId, req),
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
  // Pure classifier exported for the evidence/ranking regression tests.
  skillReviewGroups,
};
