const mongoose = require("mongoose");
const crypto = require("crypto");
const env = require("../config/env");
const logger = require("../utils/logger");
const User = require("../models/User");
const DraftCV = require("../models/DraftCV");
const subscription = require("../services/subscription.service");
const aiService = require("../services/ai.service");
const langService = require("../services/language.service");
const modelSelection = require("../services/modelSelection.service");
const { coachState } = require("../services/atsCoach.service");
const skillNormalizer = require("../services/skillNormalizer.service");
const { TRANSACTION_TYPES } = require("../config/transactionTypes");

// The valid Role-Brief company types (mirrors DraftCV.targetJob.brief.companyType
// and ai.service's framing map). Used to validate the infer+confirm chip.
const COMPANY_TYPES = [
  "startup",
  "enterprise",
  "agency",
  "nonprofit",
  "government",
  "smb",
  "unknown",
];

// Human labels for the builder steps (mirrors the frontend STEP_NOUNS). Used to
// tell Aria which section the student is on. Falls back to 'your CV'.
const STEP_LABELS = {
  target_job: "target job",
  heading: "contact details",
  history: "work history",
  projects: "projects",
  education: "education",
  skills: "skills",
  summary: "summary",
  finalize: "review",
};

// The JD-identity hash a brief is keyed by. Shared so every caller (draft-attached or
// not) derives the SAME key from the same job text — that identity is what lets a
// preview-built brief be persisted onto a draft later without a rebuild.
const briefHashFor = (jd) => crypto.createHash("sha256").update(jd).digest("hex");

// Build Aria's Role Brief from RAW JD text — no draft required. The draft-attached
// path (resolveDraftBrief) and the draftless path (Aria Studio's brief preview) both
// go through here, so there is exactly one place that turns a JD into a brief.
// Returns { brief, hash }. aiService.buildRoleBrief wraps extractJobRequirements,
// which is withExtractionCache-backed, so an identical JD is free on repeat.
const buildBriefForJd = async (jobDescription, title, meta) => {
  const jd = (jobDescription || "").trim();
  if (!jd) return { brief: null, hash: null };
  const brief = await aiService.buildRoleBrief(jd, { title }, meta);
  return { brief, hash: briefHashFor(jd) };
};

const requirementIdFor = (type, name) =>
  `req_${crypto
    .createHash("sha1")
    .update(
      `${type}|${String(name || "")
        .trim()
        .toLowerCase()}`
    )
    .digest("hex")
    .slice(0, 12)}`;

// Add a safe typed checklist to briefs created before requirements[] existed. This is
// deliberately deterministic: old must-have chips become generic skills and old
// responsibility strings remain responsibilities. A future JD edit/re-read upgrades
// them with richer aliases and proof signals from the parser.
const typedRequirementsForLegacyBrief = (brief) => {
  const plain = brief?.toObject ? brief.toObject() : brief || {};
  if (Array.isArray(plain.requirements) && plain.requirements.length) return plain.requirements;
  const skillRows = [
    ...(Array.isArray(plain.mustHaves)
      ? plain.mustHaves.map((item) => ({ item, priority: "must_have" }))
      : []),
    ...(Array.isArray(plain.niceToHaves)
      ? plain.niceToHaves.map((item) => ({ item, priority: "nice_to_have" }))
      : []),
  ];
  const skills = skillRows
    .map(({ item, priority }) => {
      const name = String(typeof item === "string" ? item : item?.name || "").trim();
      if (!name) return null;
      return {
        id: requirementIdFor("skill", name),
        name,
        type: "skill",
        priority,
        explicit: true,
        aliases: [],
        proofSignals: [],
        sourceText: name,
        plausibleExperienceTypes: [],
      };
    })
    .filter(Boolean);
  const responsibilities = (Array.isArray(plain.responsibilities) ? plain.responsibilities : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((name) => ({
      id: requirementIdFor("responsibility", name),
      name,
      type: "responsibility",
      priority: "must_have",
      explicit: true,
      aliases: [],
      proofSignals: [],
      sourceText: name,
      plausibleExperienceTypes: [],
    }));
  return [...skills, ...responsibilities];
};

// Resolve (and cache) Aria's Role Brief for a draft. The brief is keyed by a hash
// of the current JD text: a cache hit (brief present AND briefHash matches the
// current JD) returns the stored brief untouched — crucially preserving a
// user-confirmed companyType. On a miss (no brief, or the JD changed) it rebuilds
// via buildBriefForJd, persists brief + briefHash, and returns it.
const resolveDraftBrief = async (draft, meta) => {
  const jd = (draft.targetJob?.description || "").trim();
  if (!jd) return null;
  const hash = briefHashFor(jd);

  const cached = draft.targetJob?.brief;
  if (cached && draft.targetJob?.briefHash === hash) {
    const plain = cached.toObject ? cached.toObject() : cached;
    // JD unchanged — preserve the user's confirmed companyType. Older briefs get an
    // additive local checklist migration; no AI call and no charge.
    if (!Array.isArray(plain.requirements) || !plain.requirements.length) {
      return { ...plain, requirements: typedRequirementsForLegacyBrief(plain) };
    }
    return plain;
  }

  const { brief } = await buildBriefForJd(jd, draft.targetJob?.title, meta);
  draft.targetJob.brief = brief;
  draft.targetJob.briefHash = hash;
  await draft.save();
  return brief;
};

// The role's must-haves NOT yet covered by the draft — computed with the scoring
// engine's own matcher so "covered while building" agrees with the later scan. Empty
// when there's no brief/must-haves. Must-haves first, then capped.
const openMustHavesFromDraft = (draft, brief, cap = 6) => {
  const mustHaves = Array.isArray(brief?.mustHaves) ? brief.mustHaves : [];
  if (!mustHaves.length) return [];
  const text = [
    ...(draft.experience || []).map((e) => e?.description || ""),
    ...(draft.projects || []).map((p) => p?.description || ""),
    draft.professionalSummary || "",
  ]
    .filter(Boolean)
    .join("\n");
  const skills = (draft.skills || [])
    .map((s) => (typeof s === "string" ? s : s?.name))
    .filter(Boolean);
  const { results } = skillNormalizer.computeKeywordCoverage(mustHaves, { text, skills });
  return results
    .filter((r) => !r.covered)
    .sort((a, b) => (b.importance === "must_have" ? 1 : 0) - (a.importance === "must_have" ? 1 : 0))
    .slice(0, cap)
    .map((r) => ({ name: r.name, importance: r.importance }));
};

// Narrow the CV-wide open requirements to the few that are most plausible for the
// entry Aria is interviewing NOW. The model still makes the final plausibility call;
// this deterministic pre-filter stops a long JD from turning every role into the same
// keyword interrogation.
const targetRequirementsForEntry = (draft, brief, entry, turns = [], cap = 3) => {
  const typed = Array.isArray(brief?.requirements) ? brief.requirements : [];
  const openSkills = openMustHavesFromDraft(draft, brief, Math.max(cap * 3, 6));
  // Responsibilities are not skill chips, but they are valuable interview leads. They
  // join the candidate pool as typed requirements and can rank only when this role's
  // title/answers make them plausible.
  const responsibilityLeads = typed
    .filter((item) => item?.type === "responsibility" && item?.name)
    .map((item) => ({ name: item.name, importance: item.priority || "must_have" }));
  const open = [...openSkills, ...responsibilityLeads].filter(
    (item, index, items) =>
      items.findIndex(
        (candidate) =>
          String(candidate.name || "").toLowerCase() === String(item.name || "").toLowerCase()
      ) === index
  );
  if (!open.length) return [];

  const byName = new Map(typed.map((r) => [String(r?.name || "").toLowerCase(), r]));
  const context = [
    entry?.title,
    entry?.company,
    entry?.entryType,
    ...(turns || []).filter((m) => m?.who === "user").map((m) => m.text),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const tokens = new Set(context.match(/[a-z0-9+#.]{3,}/g) || []);
  const overlap = (value) =>
    String(value || "")
      .toLowerCase()
      .match(/[a-z0-9+#.]{3,}/g)
      ?.filter((token) => tokens.has(token)).length || 0;

  return open
    .map((item, index) => {
      const meta = byName.get(String(item.name || "").toLowerCase()) || {};
      const signals = [item.name, ...(meta.aliases || []), ...(meta.proofSignals || [])];
      const relevance = signals.reduce((score, signal) => score + overlap(signal), 0);
      return {
        ...item,
        ...(meta.id ? { id: meta.id } : {}),
        ...(meta.type ? { type: meta.type } : {}),
        aliases: meta.aliases || [],
        proofSignals: meta.proofSignals || [],
        relevance,
        originalIndex: index,
      };
    })
    .sort((a, b) => b.relevance - a.relevance || a.originalIndex - b.originalIndex)
    .slice(0, cap)
    .map((item) => {
      const result = { ...item };
      delete result.originalIndex;
      return result;
    });
};

const normalizedProbeText = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const probeTerms = (requirement) =>
  [requirement?.name, ...(requirement?.aliases || [])]
    .map(normalizedProbeText)
    .filter((term) => term.length >= 3);

// Make JD guidance visible without turning the interview into a checklist. The first
// user answer stays activity-led. From answer two onward, one relevant, not-yet-asked
// requirement can be made explicit. If the previous Aria turn was already a JD probe,
// the next response returns to the user's work before another requirement is considered.
const selectRequiredRequirementProbe = (requirements, turns = [], buildTurns = 0) => {
  if (Number(buildTurns) < 2 || !Array.isArray(requirements) || !requirements.length) return null;

  const latestUser = [...turns].reverse().find((turn) => turn?.who === "user" && turn.text);
  if (/\?\s*$/.test(String(latestUser?.text || "").trim())) return null;

  const ariaTurns = (turns || [])
    .filter((turn) => turn?.who === "aria" && turn.text)
    .map((turn) => normalizedProbeText(turn.text));
  const lastAria = ariaTurns.at(-1) || "";
  const wasNamedIn = (requirement, text) =>
    !!text && probeTerms(requirement).some((term) => text.includes(term));

  // Alternate between explicit JD checks and normal evidence-building follow-ups.
  if (requirements.some((requirement) => wasNamedIn(requirement, lastAria))) return null;

  return (
    requirements.find(
      (requirement) =>
        Number(requirement?.relevance || 0) > 0 &&
        !ariaTurns.some((turnText) => wasNamedIn(requirement, turnText))
    ) || null
  );
};

const cleanEvidenceList = (value, cap = 8) =>
  (Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, cap);

const normalizedEvidenceText = (value) =>
  String(value || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// Evidence is accepted only when the model supplies a quote copied from a real USER
// turn. The model may summarize the claim, but it cannot create an unattached fact and
// have that fact reach the bullet writer.
const verifiedInterviewEvidence = (rawEvidence, turns, requirements = []) => {
  const userTurns = (turns || [])
    .filter((m) => m?.who === "user" && m.text)
    .map((m, index) => ({
      index,
      text: String(m.text).trim(),
      normalized: normalizedEvidenceText(m.text),
    }));
  const requirementsById = new Map(
    (requirements || []).map((requirement) => [requirement?.id, requirement]).filter(([id]) => id)
  );
  const seen = new Set();

  return (Array.isArray(rawEvidence) ? rawEvidence : [])
    .map((item) => {
      const quote = String(item?.sourceQuote || "").trim();
      const normalizedQuote = normalizedEvidenceText(quote);
      if (normalizedQuote.length < 3) return null;
      const source = userTurns.find((turn) => turn.normalized.includes(normalizedQuote));
      if (!source) return null;
      const claim = String(item?.claim || quote)
        .trim()
        .slice(0, 500);
      const key = `${normalizedQuote}|${normalizedEvidenceText(claim)}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const id = `ev_${crypto.createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
      const skills = cleanEvidenceList(item?.skills, 10);
      const tools = cleanEvidenceList(item?.tools, 10);
      const evidenceText = normalizedEvidenceText([quote, claim, ...skills, ...tools].join(" "));
      const supportedRequirementIds = cleanEvidenceList(item?.requirementIds, 8).filter(
        (idValue) => {
          const requirement = requirementsById.get(idValue);
          if (!requirement) return false;
          const exactTerms = [requirement.name, ...(requirement.aliases || [])]
            .map(normalizedEvidenceText)
            .filter(Boolean);
          if (exactTerms.some((term) => evidenceText.includes(term))) return true;
          // A tool/technology/certification must be NAMED. Activity signals can make
          // Excel plausible to ask about, but preparing a report does not prove Excel.
          if (["tool", "technology", "certification"].includes(requirement.type)) return false;
          return (requirement.proofSignals || [])
            .map(normalizedEvidenceText)
            .filter(Boolean)
            .some((signal) => evidenceText.includes(signal));
        }
      );
      return {
        id,
        claim,
        sourceQuote: quote,
        sourceTurn: source.index,
        skills,
        tools,
        outcomes: cleanEvidenceList(item?.outcomes, 6),
        metrics: cleanEvidenceList(item?.metrics, 6),
        requirementIds: supportedRequirementIds,
      };
    })
    .filter(Boolean)
    .slice(0, 12);
};

const verifiedRequirementChecks = (rawChecks, requirements, evidence) => {
  const allowed = new Map((requirements || []).map((r) => [r?.id, r]).filter(([id]) => id));
  const evidenceIds = new Set((evidence || []).map((item) => item.id));
  const statuses = new Set([
    "confirmed",
    "demonstrated",
    "related",
    "not_demonstrated",
    "not_applicable",
  ]);
  const seen = new Set();
  return (Array.isArray(rawChecks) ? rawChecks : [])
    .map((item) => {
      const requirement = allowed.get(item?.requirementId);
      const status = statuses.has(item?.status) ? item.status : null;
      if (!requirement || !status || seen.has(requirement.id)) return null;
      const indexedEvidence = Number.isInteger(item?.evidenceIndex)
        ? evidence[item.evidenceIndex]?.id
        : null;
      const evidenceId =
        indexedEvidence || (evidenceIds.has(item?.evidenceId) ? item.evidenceId : null);
      const citedEvidence = (evidence || []).find((entry) => entry.id === evidenceId);
      if (
        ["confirmed", "demonstrated", "related"].includes(status) &&
        (!evidenceId || !citedEvidence?.requirementIds?.includes(requirement.id))
      )
        return null;
      seen.add(requirement.id);
      return {
        requirementId: requirement.id,
        name: requirement.name,
        status,
        evidenceId,
        note: String(item?.note || "")
          .trim()
          .slice(0, 240),
      };
    })
    .filter(Boolean);
};

// @desc    Live conversational CV coach — a short, personal, gap-aware message
//          (and optional step-by-step guide) for the user's current step. Free
//          users get a daily quota; paid tiers are unlimited. Always degrades to
//          a client-side scripted fallback (never blank, never hard-blocks).
// @route   POST /api/coach/guide
// @access  Private (job-seekers only)
const guide = async (req, res) => {
  const { draftId, step, signal, cvData } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    let draft;
    if (draftId === "new") {
      draft = cvData || {};
    } else {
      if (!mongoose.Types.ObjectId.isValid(draftId)) {
        return res.status(400).json({ message: "Invalid draftId format" });
      }
      draft = await DraftCV.findById(draftId);
      if (!draft) {
        return res.status(404).json({ message: "CV not found" });
      }
      if (draft.userId.toString() !== req.user.id) {
        return res.status(403).json({ message: "Not authorized" });
      }
    }

    const user = await User.findById(req.user.id).select("plan subscription");
    // The conversational coach is a PAID feature, gated on the effective subscription
    // (subscription.isPaidActive — honors expiry, the canonical paid check used across
    // the backend). Free users get the deterministic CV Journey only — no AI coaching.
    if (!subscription.isPaidActive(user)) {
      return res.json({ locked: true });
    }

    // Prefer the live cvData the client sends (what the user has typed RIGHT NOW)
    // over the saved draft, which lags until a step transition. Falls back to the
    // draft when no live state is provided.
    const gaps = coachState(cvData && typeof cvData === "object" ? cvData : draft);
    let result;
    try {
      result = await aiService.coachMessage(
        {
          firstName: gaps.firstName,
          step: step || draft.currentStep || "",
          gaps,
          signal: (signal || "").toString().slice(0, 200),
        },
        { userId: req.user.id, operation: "coachGuide", lang: req.lang }
      );
    } catch (err) {
      if (err instanceof aiService.AIUnavailableError) {
        return res.json({ fallback: true });
      }
      throw err;
    }

    return res.json({ ...result });
  } catch (error) {
    console.error("Coach Guide Error:", error);
    // Soft-fail to the client's scripted coach rather than erroring the UI.
    return res.json({ fallback: true });
  }
};

// @desc    Aria "build-with" bullet generation — turn a described role/project into
//          `count` truthful, Role-Brief-grounded bullets. Charges count × GENERATE_BULLET
//          (paid tiers draw from allowance via chargeOrSkip). The first re-roll of an
//          identical request is free (genState bookkeeping). Does NOT auto-apply — the
//          frontend shows the bullets and the user appends them via the autosave path.
// @route   POST /api/coach/generate-bullets
// @access  Private (job-seekers only — not CV-agent client CVs)
const generateBullets = async (req, res) => {
  const { draftId, section, sortId, description, count, reroll } = req.body || {};
  if (!draftId || !sortId || !["experience", "project"].includes(section)) {
    return res
      .status(400)
      .json({ message: "draftId, section ('experience'|'project') and sortId are required" });
  }
  const n = parseInt(count, 10);
  if (!Number.isInteger(n) || n < 1 || n > 6) {
    return res.status(400).json({ message: "count must be an integer between 1 and 6" });
  }
  const desc = String(description || "").trim();
  if (desc.length < 15) {
    return res
      .status(400)
      .json({ message: "Describe what you did in a bit more detail (at least 15 characters)." });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }

    const list = section === "experience" ? draft.experience : draft.projects;
    const entry = (list || []).find((e) => e._sortId === sortId);
    if (!entry) {
      return res
        .status(404)
        .json({ message: "That role is no longer in your CV. Refresh and try again." });
    }

    const user = await User.findById(req.user.id).select("plan subscription credits");
    // DOCUMENT action — bullets are CV content, so they follow the CV's language,
    // not the language Aria is speaking in.
    const meta = {
      userId: req.user.id,
      operation: "coachGenerateBullets",
      lang: langService.docLang(draft, req),
    };

    // Ground on the Role Brief. Non-fatal: fall back to a brief-less generation.
    let brief = null;
    try {
      brief = await resolveDraftBrief(draft, meta);
    } catch (briefErr) {
      console.error(
        "Coach resolveDraftBrief error (generateBullets, brief-less):",
        briefErr.message
      );
    }

    const evidenceMap = draft.coachEvidence?.toObject
      ? draft.coachEvidence.toObject()
      : draft.coachEvidence || {};
    const evidenceLedger = evidenceMap[sortId] || null;

    // Resolve the model (session pick → user default → DEFAULT_MODEL), gate it, and price
    // the bullet by its TIER (flagship costs more per bullet). count × per-bullet cost.
    const {
      modelId,
      tier,
      cost: perBullet,
    } = await modelSelection.resolveForAction({
      action: "GENERATE_BULLET",
      sessionModelId: req.body?.model,
      draft,
      user,
    });
    const cost = n * perBullet;

    // The first re-roll of an IDENTICAL request (same section+sortId+description+count)
    // is free — a charged generation re-grants exactly one; using it flips the flag.
    const descHash = crypto
      .createHash("sha256")
      .update(`${section}|${sortId}|${desc}|${n}|${JSON.stringify(evidenceLedger?.evidence || [])}`)
      .digest("hex");
    const entryState = draft.genState?.[sortId];
    const isFreeReroll =
      reroll === true && entryState?.hash === descHash && entryState?.freeRerollAvailable === true;

    // PRE-CHECK the balance before spending an AI call the user can't pay for
    // (paid tiers pass via their allowance — availableCredits includes it).
    if (!isFreeReroll && subscription.availableCredits(user) < cost) {
      return res.status(403).json({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits",
        required: cost,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    let bulletDetails;
    try {
      bulletDetails = await aiService.generateBulletsFromDescription(desc, n, {
        brief,
        role: entry.title || (section === "experience" ? "this role" : "this project"),
        section,
        evidenceLedger,
        returnDetails: true,
        // Route through the multi-provider dispatcher via the selected model id.
        meta: { ...meta, modelId },
      });
    } catch (genErr) {
      if (genErr instanceof aiService.AIUnavailableError) {
        return res
          .status(503)
          .json({ message: "AI is not configured right now. Please try again later." });
      }
      console.error("Coach generateBullets AI error:", genErr.message);
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }
    // Once a verified ledger exists, an uncited output is rejected before charging.
    // This makes traceability a backend invariant rather than a UI promise.
    if (evidenceLedger?.evidence?.length) {
      bulletDetails = (bulletDetails || []).filter((item) => item.evidenceIds?.length);
    }
    if (!Array.isArray(bulletDetails) || bulletDetails.length === 0) {
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }
    const evidenceById = new Map((evidenceLedger?.evidence || []).map((item) => [item.id, item]));
    const requirementById = new Map((brief?.requirements || []).map((item) => [item.id, item]));
    const safeDetails = bulletDetails.map((item) => ({
      text: item.text,
      evidence: (item.evidenceIds || [])
        .map((id) => evidenceById.get(id))
        .filter(Boolean)
        .map((evidence) => ({
          id: evidence.id,
          claim: evidence.claim,
          sourceQuote: evidence.sourceQuote,
        })),
      requirements: (item.requirementIds || [])
        .map((id) => requirementById.get(id))
        .filter(Boolean)
        .map((requirement) => ({ id: requirement.id, name: requirement.name })),
    }));
    const bullets = safeDetails.map((item) => item.text);

    // Charge on success (skipped for a free re-roll). Rare race: a concurrent spend
    // between the pre-check and here can still come back insufficient.
    if (!isFreeReroll) {
      // Tier-aware charge: LIGHT is free on an active paid plan (the unlimited perk);
      // FLAGSHIP always meters, even for paid subscribers.
      const charge = await modelSelection.chargeForModel(user, cost, tier, {
        type: TRANSACTION_TYPES.GENERATE_BULLET,
        description: `Aria bullets (${n})`,
      });
      if (charge.insufficient) {
        return res.status(402).json({
          code: "INSUFFICIENT_CREDITS",
          message: "Insufficient credits",
          required: cost,
          remainingCredits: subscription.availableCredits(user),
        });
      }
    }

    // Re-grant exactly one free re-roll for this exact request; a free re-roll
    // consumes it (freeRerollAvailable=false) so only the immediate next is free.
    if (!draft.genState) draft.genState = {};
    draft.genState[sortId] = { hash: descHash, freeRerollAvailable: !isFreeReroll };
    draft.markModified("genState");
    await draft.save();

    return res.json({
      bullets,
      bulletDetails: safeDetails,
      wasFree: isFreeReroll,
      cost: isFreeReroll ? 0 : cost,
      remainingCredits: subscription.availableCredits(user),
    });
  } catch (error) {
    if (error instanceof aiService.AIUnavailableError) {
      return res
        .status(503)
        .json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Coach Generate Bullets Error:", error);
    return res.status(500).json({ message: "Failed to generate bullets" });
  }
};

// @desc    Generate ONE career-stage-aware, JD-tailored professional summary.
//          Credited per draft (each re-roll charges again), mirroring generateBullets'
//          charge pattern: pre-check balance → generate → charge on confirmed success.
// @route   POST /api/coach/summary
// @access  Private
const summary = async (req, res) => {
  const { draftId, stage } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }
    const careerStage = aiService.resolveCareerStage({ stage, draft });

    const user = await User.findById(req.user.id).select("plan subscription credits");
    // Resolve + gate the session model, priced by its tier (flagship summary costs more).
    const { modelId, tier, cost } = await modelSelection.resolveForAction({
      action: "GENERATE_SUMMARY",
      sessionModelId: req.body?.model,
      draft,
      user,
    });

    // PRE-CHECK the balance before spending an AI call the user can't pay for — only when
    // it will actually meter (a paid LIGHT summary is free/unlimited; flagship always meters).
    const willMeter = tier === "flagship" || !subscription.isPaidActive(user);
    if (willMeter && subscription.availableCredits(user) < cost) {
      return res.status(403).json({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits",
        required: cost,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    // Build the grounding context server-side — same shape ProfessionalSummary.jsx
    // assembled client-side (name, target title, skills list, work-history one-liners,
    // existing summary draft).
    const skillsStr = (draft.skills || [])
      .map((s) => (typeof s === "object" ? s.type || s.name : s))
      .filter(Boolean)
      .join(", ");
    const historyStr = (draft.experience || [])
      .map(
        (exp) =>
          `${exp.title} at ${exp.company} (${exp.startDate}-${exp.isCurrent ? "Present" : exp.endDate})`
      )
      .join("; ");
    const context = `
                Candidate Name: ${draft.personalInfo?.fullName || "Candidate"}
                Target Job Title: ${draft.targetJob?.title || "Professional"}

                Key Skills: ${skillsStr}

                Work History Summary: ${historyStr}

                Existing Summary Draft: ${draft.professionalSummary || ""}
            `.trim();

    // The gaps the Studio's section scan found in THIS CV's summary, sent by the client
    // with the fix request. Sanitised here rather than trusted: it is request body, it
    // lands in a prompt, and a caller could otherwise smuggle instructions in through a
    // "keyword". Strings only, trimmed, deduped case-insensitively, hard-capped at 10 and
    // 60 chars each — a real ATS keyword is a word or two, so anything longer is not one.
    const missingKeywords = (() => {
      const seen = new Set();
      return (Array.isArray(req.body?.missingKeywords) ? req.body.missingKeywords : [])
        .map((k) => String(typeof k === "string" ? k : k?.name || "").trim())
        .filter((k) => {
          if (!k || k.length > 60) return false;
          const key = k.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 10);
    })();

    let result;
    try {
      result = await aiService.generateSummaryForStage({
        stage: careerStage,
        role: draft.targetJob?.title || "Professional",
        context,
        jobDescription: (draft.targetJob?.description || "").trim(),
        // Empty on the build track (no scan has run) — correct, not a gap.
        missingKeywords,
        // Route through the selected model via meta.modelId (multi-provider dispatcher).
        // DOCUMENT action — the summary is CV content (see coachGenerateBullets).
        meta: {
          userId: req.user.id,
          operation: "coachSummary",
          modelId,
          lang: langService.docLang(draft, req),
        },
      });
    } catch (genErr) {
      if (genErr instanceof aiService.AIUnavailableError) {
        return res
          .status(503)
          .json({ message: "AI is not configured right now. Please try again later." });
      }
      console.error("Coach summary AI error:", genErr.message);
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }

    // generateSummaryForStage returns the summary STRING directly.
    const text = (result || "").trim();
    if (!text) {
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }

    // Charge on confirmed success — tier-aware (flagship always meters; light free on an
    // active paid plan). Rare race: a concurrent spend can still come back insufficient.
    const charge = await modelSelection.chargeForModel(user, cost, tier, {
      type: TRANSACTION_TYPES.GENERATE_SUMMARY,
      description: "Aria summary",
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
      summary: text,
      cost,
      remainingCredits: subscription.availableCredits(user),
    });
  } catch (error) {
    if (error instanceof aiService.AIUnavailableError) {
      return res
        .status(503)
        .json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Coach Summary Error:", error);
    return res.status(500).json({ message: "Failed to generate summary" });
  }
};

// @desc    Confirm or correct the inferred company type on Aria's Role Brief.
//          Powers the infer+confirm chip: sets companyType + marks it confirmed
//          so a later brief rebuild (same JD) keeps the user's choice.
// @route   POST /api/coach/company-type
// @access  Private
const setCompanyType = async (req, res) => {
  const { draftId, companyType } = req.body || {};
  if (!draftId || !companyType) {
    return res.status(400).json({ message: "draftId and companyType are required" });
  }
  if (!COMPANY_TYPES.includes(companyType)) {
    return res
      .status(400)
      .json({ message: `companyType must be one of: ${COMPANY_TYPES.join(", ")}` });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }

    // Ensure the brief subdoc exists (it may not yet if no rewrite/scan has run).
    if (!draft.targetJob) draft.targetJob = {};
    if (!draft.targetJob.brief) draft.targetJob.brief = {};
    draft.targetJob.brief.companyType = companyType;
    draft.targetJob.brief.companyTypeConfirmed = true;
    await draft.save();

    const brief = draft.targetJob.brief;
    return res.json({ brief: brief.toObject ? brief.toObject() : brief });
  } catch (error) {
    console.error("Coach Set Company Type Error:", error);
    return res.status(500).json({ message: "Failed to update company type" });
  }
};

// Shared Aria-chat daily allowance. ONE free pool covers BOTH the section chat
// (/coach/ask) and the unified /coach/chat (general + build-with): 15 messages/day
// per user (calendar-date window), then ARIA_CHAT_MESSAGE credits each (paid users
// included — no exemption past the free daily allowance).
const FREE_DAILY_CHATS = 15;

// Pre-check the allowance (BEFORE the AI call). Returns today's key, how many chats
// were used in that window, and whether this turn will charge credits.
const chatAllowance = (user) => {
  const today = new Date().toISOString().slice(0, 10);
  const used = user.ariaChat?.date === today ? user.ariaChat.count || 0 : 0;
  return { today, used, willCharge: used >= FREE_DAILY_CHATS };
};

// Commit a chat turn AFTER the AI succeeds. FLAGSHIP charges on EVERY turn (it never
// touches the free pool). LIGHT rides the free daily pool first, then charges the
// (action, tier) cost — and is free entirely on an active paid plan (the "unlimited
// light on paid" perk). `tier` defaults to 'light' so the model-agnostic /coach/ask path
// keeps working. Returns { insufficient } on a lost charge race, else { charged, freeRemaining }.
const commitChatTurn = async (user, pre, cost, tier = "light") => {
  // FLAGSHIP never draws from the free daily pool — it always meters, per
  // modelSelection.service's locked rule. The pool is a LIGHT-model perk; 15 free
  // Sonnet-class turns a day per user is the same blow-out the build-with metering
  // below closes. A charged flagship turn does NOT consume a free-pool slot.
  if (tier === "flagship") {
    const r = await modelSelection.chargeForModel(user, cost, tier, {
      type: TRANSACTION_TYPES.ARIA_CHAT,
      description: "Aria chat (Pro model)",
    });
    if (r.insufficient) return { insufficient: true };
    await user.save();
    return { charged: r.charged, freeRemaining: Math.max(0, FREE_DAILY_CHATS - pre.used) };
  }
  if (pre.willCharge) {
    const r = await modelSelection.chargeForModel(user, cost, tier, {
      type: TRANSACTION_TYPES.ARIA_CHAT,
      description: "Aria chat",
    });
    if (r.insufficient) return { insufficient: true };
    await user.save();
    // Charged past the pool → nothing free left. A tier-SKIP (paid light) is genuinely
    // free but the pool is still spent for the day, so freeRemaining stays 0 here.
    return { charged: r.charged, freeRemaining: 0 };
  }
  user.ariaChat = { date: pre.today, count: pre.used + 1 };
  await user.save();
  return { charged: false, freeRemaining: Math.max(0, FREE_DAILY_CHATS - (pre.used + 1)) };
};

// Will this turn ACTUALLY spend credits? FLAGSHIP always does — it never rides the free
// pool, so the tier check must come FIRST (gating on pre.willCharge would report "won't
// meter" for a flagship turn inside the pool and skip the pre-flight balance check).
// LIGHT only past the pool, and never on an active paid plan (unlimited light) — so a
// paid light user is never wrongly blocked with CHAT_LIMIT_REACHED.
const turnWillMeter = (user, pre, tier) =>
  tier === "flagship" || (pre.willCharge && !subscription.isPaidActive(user));

// Refuse a turn the user can't pay for. The two tiers fail for DIFFERENT reasons and
// must not share a message: a LIGHT user has genuinely burned the day's free pool and
// their credits ("come back tomorrow" is true). A FLAGSHIP user may have the whole free
// pool left — Pro simply never rides it — so "you've used today's free chats" is wrong,
// and it hides the actual way out: switch back to Standard, which is still free.
const refuseChatTurn = (res, { tier, cost, user, pre, building = false }) => {
  if (tier === "flagship") {
    return res.status(403).json({
      code: "INSUFFICIENT_CREDITS",
      message: building
        ? "Building with the Pro model costs credits. Switch to Standard — it's free — or top up."
        : "The Pro model costs credits per message. Switch to Standard — it's free — or top up.",
      required: cost,
      remainingCredits: subscription.availableCredits(user),
      freeRemaining: Math.max(0, FREE_DAILY_CHATS - (pre?.used || 0)),
    });
  }
  return res.status(402).json({
    code: "CHAT_LIMIT_REACHED",
    message: "You've used today's free chats — top up or come back tomorrow.",
    freeRemaining: 0,
  });
};

// Free build-with turns are never charged, but they ARE bounded per day so a
// tampered/looping client can't run unlimited AI calls. A real CV build uses
// ~40 turns total, so this ceiling is invisible in normal use.
const buildAllowance = (user) => {
  const today = new Date().toISOString().slice(0, 10);
  const used = user.ariaBuild?.date === today ? user.ariaBuild.count || 0 : 0;
  return { today, used, exhausted: used >= env.ARIA_BUILD_DAILY_CAP };
};

// @desc    Aria's free-form coach chat. Warm, on-task, guardrailed Q&A about the
//          current CV/section/target role on the CHEAP base model. Draws from the
//          shared daily chat allowance (see FREE_DAILY_CHATS), then credits.
// @route   POST /api/coach/ask
// @access  Private (job-seekers only — not CV-agent client CVs)
const askAria = async (req, res) => {
  const { draftId, currentStepId, question, model } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ message: "question is required" });
  }
  const q = question.trim();
  if (q.length < 1 || q.length > 500) {
    return res.status(400).json({ message: "question must be between 1 and 500 characters" });
  }
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to view this CV" });
    }

    const user = await User.findById(req.user.id).select(
      "plan subscription credits ariaChat aiModelId"
    );

    // Shared daily allowance (section chat + build-with). The selected model's tier
    // decides whether this turn meters and which per-message cost applies.
    const pre = chatAllowance(user);
    const { modelId, tier, cost } = await modelSelection.resolveForAction({
      action: "ARIA_CHAT_MESSAGE",
      sessionModelId: model,
      draft,
      user,
    });

    // Pre-check the balance before spending an AI call the user can't pay for.
    if (turnWillMeter(user, pre, tier) && subscription.availableCredits(user) < cost) {
      return refuseChatTurn(res, { tier, cost, user, pre });
    }

    // Compact, cheap context: target title + one line of section-progress counts.
    const meta = {
      userId: req.user.id,
      operation: "coachAskAria",
      modelId,
      lang: req.lang,
    };
    const targetTitle = (draft.targetJob?.title || draft.targetJob?.brief?.role || "").trim();
    const cvSummary = `${targetTitle ? `Target: ${targetTitle}. ` : ""}Progress: ${
      draft.experience?.length || 0
    } roles, ${draft.projects?.length || 0} projects, ${draft.skills?.length || 0} skills, summary ${
      draft.professionalSummary?.trim() ? "written" : "empty"
    }.`;

    let brief = null;
    try {
      brief = await resolveDraftBrief(draft, meta);
    } catch (briefErr) {
      console.error("Coach askAria resolveDraftBrief error (brief-less):", briefErr.message);
    }

    const stepLabel = STEP_LABELS[currentStepId] || "your CV";
    const careerStage = aiService.resolveCareerStage({ draft });

    let answer;
    try {
      answer = await aiService.answerCoachQuestion({
        question: q,
        stepLabel,
        cvSummary,
        brief,
        careerStage,
        meta,
      });
    } catch (aiErr) {
      if (aiErr instanceof aiService.AIUnavailableError) {
        return res
          .status(503)
          .json({ message: "AI is not configured right now. Please try again later." });
      }
      console.error("Coach askAria AI error:", aiErr.message);
      return res.status(502).json({ message: "Couldn't answer right now. Please try again." });
    }

    // Charge-or-count only AFTER a successful answer (no charge/increment on failure).
    const c = await commitChatTurn(user, pre, cost, tier);
    if (c.insufficient) {
      return refuseChatTurn(res, { tier, cost, user, pre });
    }

    return res.json({
      answer,
      freeRemaining: c.freeRemaining,
      charged: c.charged,
      // See /coach/chat: post-charge balance for the wallet pill, null when free.
      remainingCredits: c.charged ? subscription.availableCredits(user) : null,
    });
  } catch (error) {
    console.error("Coach Ask Aria Error:", error);
    return res.status(500).json({ message: "Failed to answer" });
  }
};

// Hard per-round turn cap for focused build-with in /coach/chat: at the cap, the
// model is forced to wrap up to a draft so the conversation always converges.
const INTERVIEW_TURN_CAP = 6;
const STUDIO_INTERVIEW_TURN_CAP = 10;

// @desc    Aria's UNIFIED chat — ONE front door. Focus-aware + intent-classified on
//          the CHEAP base model: a focused 'building'/'ready' turn is FREE (build-with);
//          a general question ('answer') spends the daily allowance. Charging is
//          SMART PER-MESSAGE. Same guardrails/allowance as /coach/ask.
// @route   POST /api/coach/chat
// @access  Private (job-seekers only — not CV-agent client CVs)
const chat = async (req, res) => {
  const { draftId, currentStepId, messages, focus, buildTurns, stage, studioInterview } =
    req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }
  if (focus && !(["experience", "project"].includes(focus.section) && focus.sortId)) {
    return res
      .status(400)
      .json({ message: "focus must be { section: 'experience'|'project', sortId }" });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ message: "messages must be a non-empty array" });
  }
  // Normalize + validate: the LAST message must be the user's new turn.
  const turns = messages
    .filter((m) => m && (m.who === "aria" || m.who === "user") && typeof m.text === "string")
    .map((m) => ({ who: m.who, text: m.text.trim() }))
    .filter((m) => m.text);
  const last = turns[turns.length - 1];
  if (!last || last.who !== "user") {
    return res.status(400).json({ message: "The last message must be the user's turn." });
  }
  if (last.text.length > 800) {
    last.text = last.text.slice(0, 800);
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }

    // Resolve the focused entry (if the client is on a specific role/project).
    let entry = null;
    if (focus) {
      const list = focus.section === "experience" ? draft.experience : draft.projects;
      entry = (list || []).find((e) => e._sortId === focus.sortId);
      if (!entry) {
        return res
          .status(404)
          .json({ message: "That role is no longer in your CV. Refresh and try again." });
      }
    }

    const user = await User.findById(req.user.id).select(
      "plan subscription credits ariaChat ariaBuild"
    );
    const pre = chatAllowance(user);
    const preBuild = buildAllowance(user);
    // Resolve the session's model (session pick → draft.studioModelId → user default →
    // DEFAULT_MODEL), gate it, and price a metered turn by its TIER (flagship chat costs
    // more). The turn RUNS on this model via meta.modelId below.
    const { modelId, tier, cost } = await modelSelection.resolveForAction({
      action: "ARIA_CHAT_MESSAGE",
      sessionModelId: req.body?.model,
      draft,
      user,
    });

    // The per-interview turn cap only bounds focused BUILDING (forces a draft).
    const turnCap = studioInterview === true ? STUDIO_INTERVIEW_TURN_CAP : INTERVIEW_TURN_CAP;
    const mustFinish = !!focus && Number(buildTurns) >= turnCap;

    // Route the turn through the selected model (multi-provider dispatcher).
    const meta = { userId: req.user.id, operation: "coachChatTurn", modelId, lang: req.lang };
    const targetTitle = (draft.targetJob?.title || draft.targetJob?.brief?.role || "").trim();
    const cvSummary = `${targetTitle ? `Target: ${targetTitle}. ` : ""}Progress: ${
      draft.experience?.length || 0
    } roles, ${draft.projects?.length || 0} projects, ${draft.skills?.length || 0} skills, summary ${
      draft.professionalSummary?.trim() ? "written" : "empty"
    }.`;

    let brief = null;
    try {
      brief = await resolveDraftBrief(draft, meta);
    } catch (briefErr) {
      console.error("Coach chat resolveDraftBrief error (brief-less):", briefErr.message);
    }

    const stepLabel = STEP_LABELS[currentStepId] || "your CV";
    // Studio can unpack several activities across ten user turns, so retain the opening
    // activity list for that whole interview. Other coach surfaces keep the smaller window.
    const window = turns.slice(-(studioInterview === true ? 22 : 12));
    // The role's still-uncovered must-haves, narrowed to three candidates ranked by
    // signals in THIS entry and THIS conversation. The model must still skip anything
    // implausible; ranking is guidance, never evidence.
    const openMustHaves = focus ? targetRequirementsForEntry(draft, brief, entry, window, 3) : [];
    const requiredProbe =
      focus && !mustFinish
        ? selectRequiredRequirementProbe(openMustHaves, window, buildTurns)
        : null;

    // NO focus → every turn is a general answer (metered like /coach/ask). Pre-check
    // the balance BEFORE spending an AI call the user can't pay for — but only when the
    // turn will actually meter (a paid light user is unlimited and never blocked here;
    // a flagship user always meters, pool or no pool).
    if (!focus && turnWillMeter(user, pre, tier) && subscription.availableCredits(user) < cost) {
      return refuseChatTurn(res, { tier, cost, user, pre });
    }

    // Build-with is free but bounded — block BEFORE spending an AI call once the
    // daily anti-abuse ceiling is hit. Client-supplied buildTurns/mustFinish above
    // is a conversation-quality cap, not a cost control; this is the real backstop.
    if (focus && preBuild.exhausted) {
      await User.updateOne(
        { _id: req.user.id },
        { $inc: { "ariaBuild.capHits": 1 }, $set: { "ariaBuild.lastCapHitAt": new Date() } }
      ).catch((e) => logger.warn(`ariaBuild capHit write failed: ${e.message}`));
      logger.warn(
        `Aria build cap hit — user=${req.user.id} draft=${draftId} cap=${env.ARIA_BUILD_DAILY_CAP}`
      );
      return res.status(402).json({
        code: "BUILD_LIMIT_REACHED",
        message: "You've done a lot of building today — let's pick this up tomorrow.",
        buildRemaining: 0,
      });
    }

    // Flagship build-with still METERS (light stays free) — pre-check the balance
    // BEFORE spending an AI call the user can't pay for. See modelSelection.service:8-10.
    if (focus && tier === "flagship" && subscription.availableCredits(user) < cost) {
      return refuseChatTurn(res, { tier, cost, user, pre, building: true });
    }

    let result;
    try {
      result = await aiService.coachChatTurn({
        messages: window,
        focus: !!focus,
        entryTitle: entry?.title || "this role",
        entryCompany: (entry?.company || "").trim(),
        entryType: entry?.entryType || "",
        section: focus?.section || "",
        // Career stage forks the experience coaching: explicit chip choice wins; else
        // inferred from the draft (real job → experienced, else entry-level 'grad').
        stage: aiService.resolveCareerStage({ stage, draft }),
        stepLabel,
        cvSummary,
        brief,
        openMustHaves,
        requiredProbe,
        mustFinish,
        meta,
      });
    } catch (aiErr) {
      if (aiErr instanceof aiService.AIUnavailableError) {
        return res
          .status(503)
          .json({ message: "AI is not configured right now. Please try again later." });
      }
      // Claude occasionally returns the requested coaching prose without the JSON
      // wrapper. The response itself is useful, so deliver it rather than making the
      // user resend the exact same prompt. A focused turn defaults to "building",
      // matching the service's safe classifier default.
      if (aiErr instanceof aiService.AIJSONParseError && aiErr.response) {
        logger.warn(
          `Coach chat received non-JSON AI output; using text fallback (user=${req.user.id}, model=${modelId})`
        );
        result = {
          reply: aiErr.response,
          intent: focus ? "building" : "answer",
          description: "",
          suggestions: [],
          exampleAnswer: "",
          suggestionsLabel: "",
        };
      } else {
        console.error("Coach chat AI error:", aiErr.message);
        return res.status(502).json({ message: "Couldn't continue right now. Please try again." });
      }
    }

    // No focus → always a general answer; focused → trust the classifier.
    const intent = focus ? result.intent : "answer";

    // SMART PER-MESSAGE charging: a general 'answer' spends the chat allowance;
    // 'building'/'ready' (focused build-with) is free on LIGHT, metered on FLAGSHIP.
    let charged = false;
    let freeRemaining = Math.max(0, FREE_DAILY_CHATS - pre.used);
    if (intent === "answer") {
      const c = await commitChatTurn(user, pre, cost, tier);
      if (c.insufficient) {
        // They can't pay for a general answer — don't leak the reply. (On LIGHT they
        // can still build for free on a focused role.)
        return refuseChatTurn(res, { tier, cost, user, pre });
      }
      charged = c.charged;
      freeRemaining = c.freeRemaining;
    } else if (focus) {
      // Build-with is FREE on the LIGHT model — that's the point of Aria Studio.
      // FLAGSHIP meters even here: an unlimited Sonnet interview is exactly the
      // cost blow-out modelSelection.service is written to prevent.
      if (tier === "flagship") {
        const r = await modelSelection.chargeForModel(user, cost, tier, {
          type: TRANSACTION_TYPES.ARIA_CHAT,
          description: "Aria build-with (Pro model)",
        });
        if (r.insufficient) {
          return refuseChatTurn(res, { tier, cost, user, pre, building: true });
        }
        charged = r.charged;
      }
      // Free focused turn (building/ready) — doesn't touch the chat allowance, but
      // bumps the build anti-abuse counter so a looping client eventually gets capped.
      user.ariaBuild = { date: preBuild.today, count: preBuild.used + 1 };
      await user.save();
    }

    let evidenceLedger = null;
    const readyToDraft = intent === "ready" || (!!focus && mustFinish);
    if (focus && readyToDraft) {
      let evidence = verifiedInterviewEvidence(result.evidence, window, openMustHaves);
      // A provider that omits the structured evidence cannot strand a paid generation.
      // Fall back to the user's exact turns: less polished, but fully truthful and still
      // traceable. The bullet writer receives no unsupported model summary.
      if (!evidence.length) {
        const fallback = window
          .filter((m) => m?.who === "user" && m.text)
          .slice(-8)
          .map((m) => ({ claim: m.text, sourceQuote: m.text }));
        evidence = verifiedInterviewEvidence(fallback, window, openMustHaves);
      }
      const requirementChecks = verifiedRequirementChecks(
        result.requirementChecks,
        openMustHaves,
        evidence
      );
      evidenceLedger = {
        section: focus.section,
        sortId: focus.sortId,
        entryType: entry?.entryType || "",
        evidence,
        requirementChecks,
        updatedAt: new Date().toISOString(),
      };
      const current = draft.coachEvidence?.toObject
        ? draft.coachEvidence.toObject()
        : draft.coachEvidence || {};
      draft.coachEvidence = { ...current, [focus.sortId]: evidenceLedger };
      if (typeof draft.markModified === "function") draft.markModified("coachEvidence");
      if (typeof draft.save === "function") await draft.save();
    }

    return res.json({
      reply: result.reply,
      intent,
      readyToDraft,
      description: intent === "ready" ? result.description : "",
      evidenceLedger,
      // Answer scaffolds — only while building (Aria just asked a follow-up).
      suggestions: intent === "building" ? result.suggestions || [] : [],
      exampleAnswer: intent === "building" ? result.exampleAnswer || "" : "",
      suggestionsLabel: intent === "building" ? result.suggestionsLabel || "" : "",
      freeRemaining,
      charged,
      // Post-charge balance so the client can refresh the wallet pill without a
      // refetch. null when nothing was spent — the client then skips the dispatch
      // entirely rather than re-rendering the pill on every free turn.
      remainingCredits: charged ? subscription.availableCredits(user) : null,
      buildRemaining: Math.max(
        0,
        env.ARIA_BUILD_DAILY_CAP - (preBuild.used + (intent === "answer" ? 0 : 1))
      ),
    });
  } catch (error) {
    console.error("Coach Chat Error:", error);
    return res.status(500).json({ message: "Failed to continue the chat" });
  }
};

// @desc    Fetch (or build+cache) Aria's Role Brief for a draft — powers the
//          "Aria's read" strip + the infer+confirm company-type chip. Cheap: a
//          same-JD read returns the cached brief (no fresh AI spend). No JD → null.
// @route   POST /api/coach/brief
// @access  Private (job-seekers only — not CV-agent client CVs)
const getBrief = async (req, res) => {
  const { draftId, model } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) {
      return res.status(404).json({ message: "CV not found" });
    }
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to view this CV" });
    }

    // No target job → no brief (the flow still works without one).
    if (!(draft.targetJob?.description || "").trim()) {
      return res.json({ brief: null });
    }

    const { modelId } = await modelSelection.resolveForAction({
      action: "ARIA_CHAT_MESSAGE",
      sessionModelId: model,
      draft,
    });
    const brief = await resolveDraftBrief(draft, {
      userId: req.user.id,
      operation: "coachGetBrief",
      modelId,
      lang: req.lang,
    });
    return res.json({ brief });
  } catch (error) {
    if (error instanceof aiService.AIUnavailableError) {
      return res
        .status(503)
        .json({ message: "AI is not configured right now. Please try again later." });
    }
    console.error("Coach Get Brief Error:", error);
    return res.status(502).json({ message: "Couldn't read the job right now. Please try again." });
  }
};

// @desc    Set the Aria model for a session (and optionally the user's default). The
//          model must be `exposed` in the registry — gated server-side, never trusting
//          the client. Persists onto the draft (studioModelId) so it survives a reload.
// @route   POST /api/coach/model
// @access  Private
const setModel = async (req, res) => {
  const { draftId, model, setDefault } = req.body || {};
  if (!model || typeof model !== "string") {
    return res.status(400).json({ message: "model is required" });
  }
  // Gate: unknown or hidden models are rejected outright.
  const gate = await modelSelection.gateModel(model);
  if (!gate.ok) {
    return res
      .status(400)
      .json({ code: "MODEL_NOT_ALLOWED", message: "That model isn't available." });
  }

  try {
    // Per-session persistence (optional — a picker may set only the user default).
    if (draftId) {
      if (!mongoose.Types.ObjectId.isValid(draftId)) {
        return res.status(400).json({ message: "Invalid draftId format" });
      }
      const draft = await DraftCV.findById(draftId);
      if (!draft) return res.status(404).json({ message: "CV not found" });
      if (draft.userId.toString() !== req.user.id) {
        return res.status(403).json({ message: "Not authorized to edit this CV" });
      }
      draft.studioModelId = model;
      await draft.save();
    }
    // Optional user default (persists across sessions).
    if (setDefault === true) {
      const user = await User.findById(req.user.id).select("aiModelId");
      if (user) {
        user.aiModelId = model;
        await user.save();
      }
    }
    return res.json({ model, tier: gate.tier });
  } catch (error) {
    console.error("Coach Set Model Error:", error);
    return res.status(500).json({ message: "Couldn't save your model choice." });
  }
};

module.exports = {
  guide,
  generateBullets,
  summary,
  setCompanyType,
  setModel,
  getBrief,
  askAria,
  chat,
  // Exported so Aria Studio can build+cache a Role Brief on a freshly-cloned draft
  // without duplicating the JD-hash cache logic. Not route handlers.
  resolveDraftBrief,
  buildBriefForJd,
  briefHashFor,
  // Pure + request-free, so the "covered while building" rule can be unit-tested
  // against the scorer's own matcher without going through the chat route.
  openMustHavesFromDraft,
  targetRequirementsForEntry,
  selectRequiredRequirementProbe,
  verifiedInterviewEvidence,
  verifiedRequirementChecks,
};
