const mongoose = require("mongoose");
const crypto = require("crypto");
const env = require("../config/env");
const logger = require("../utils/logger");
const { sanitizeScreen } = require("../utils/screenContext");
const { sanitizeAnswerLayout } = require("../utils/answerLayout");
const { salvageJsonReply, looksLikeJsonObject } = require("../utils/salvageJsonReply");
const { detectRedFlags } = require("../services/atsCoach.service");
const User = require("../models/User");
const DraftCV = require("../models/DraftCV");
const subscription = require("../services/subscription.service");
const aiService = require("../services/ai.service");
const langService = require("../services/language.service");
const modelSelection = require("../services/modelSelection.service");
const { coachState } = require("../services/atsCoach.service");
const skillNormalizer = require("../services/skillNormalizer.service");
const { TRANSACTION_TYPES } = require("../config/transactionTypes");
// The SAME depth/style the call settings use — one control, two surfaces.
const { normalizeCallSettings } = require("../config/ariaCallSettings");

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

// The no-JD counterpart of resolveDraftBrief, and the ONLY consumer of inferRoleKeywords
// on the coach path — it was written and documented as the "no job description available"
// fallback, then wired only to the CV Builder's keyword panel, so with no JD the coach
// gave the model zero role vocabulary beyond the raw title string.
//
// Returns { roleFamily, keywords } or null. Cached on the draft by a hash of the role
// family so a title change re-infers and an unchanged one is free (inferRoleKeywords is
// itself withExtractionCache-backed, and returns [] in mock mode).
//
// HARD RULE, enforced by shape: these keywords are id-less. They can never be minted as
// req_* ids and never enter requirementChecks — the ledger verifies against
// brief.requirements, and admitting inferred guesses would put unverifiable "requirements"
// into the one record that is supposed to be provable.
const roleFamilyForDraft = (draft) =>
  String(
    draft?.targetJob?.noJd?.roleFamily ||
      draft?.targetJob?.title ||
      draft?.experience?.find?.((e) => String(e?.title || "").trim())?.title ||
      ""
  ).trim();

const resolveNoJdContext = async (draft, meta) => {
  // A real JD always wins; this path is only for its absence.
  if ((draft?.targetJob?.description || "").trim()) return null;
  const roleFamily = roleFamilyForDraft(draft);
  if (!roleFamily) return null;

  const hash = briefHashFor(roleFamily.toLowerCase());
  const cached = draft.targetJob?.noJd;
  if (cached?.keywordsHash === hash && Array.isArray(cached.keywords)) {
    return { roleFamily, keywords: cached.keywords };
  }

  const { keywords = [] } = (await aiService.inferRoleKeywords(roleFamily, meta)) || {};
  const clean = keywords
    .map((k) => ({
      name: String(k?.name || "").trim(),
      importance: k?.importance === "must_have" ? "must_have" : "nice_to_have",
    }))
    .filter((k) => k.name)
    .slice(0, 14);

  if (!draft.targetJob) draft.targetJob = {};
  draft.targetJob.noJd = {
    ...(cached?.toObject ? cached.toObject() : cached || {}),
    roleFamily,
    keywords: clean,
    keywordsHash: hash,
  };
  await draft.save();
  return { roleFamily, keywords: clean };
};

// The role's must-haves NOT yet covered by the draft — computed with the scoring
// engine's own matcher so "covered while building" agrees with the later scan. Empty
// when there's no brief/must-haves. Must-haves first, then capped.
const openMustHavesFromDraft = (draft, brief, cap = 6) => {
  // Qualifications and behavioural traits are excluded HERE, at the one door every
  // interview target comes through. A degree field is something you hold, not something
  // you did in a role, so "did you do Mechanical Engineering at this job?" is a question
  // with no sensible answer — and on a real posting three of the seven must-haves were
  // exactly that. A behavioural trait fails the same test from the other side: "tell me
  // about your communication skills" can only produce the vague, undefendable answer this
  // interview exists to avoid, and it was a must-have on four of nine real postings.
  // Scoring still sees both: this filters what Aria ASKS about, nothing else.
  const mustHaves = (Array.isArray(brief?.mustHaves) ? brief.mustHaves : []).filter(
    (item) => !item?.qualification && !item?.behavioural
  );
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

// ── The cross-history hunt ──────────────────────────────────────────────────
//
// Every requirement the user has explicitly said they have NOT done, by lowercased name.
// One lookup, consulted by every surface that could ask again.
// The SAME id derivation verifiedInterviewEvidence uses, so a fact banked by the hunt is
// indistinguishable from one banked by the build interview — and re-confirming the same
// thing twice cannot produce a duplicate.
const evidenceIdFor = (sourceQuote, claim) =>
  `ev_${crypto
    .createHash("sha1")
    .update(`${normalizedEvidenceText(sourceQuote)}|${normalizedEvidenceText(claim)}`)
    .digest("hex")
    .slice(0, 12)}`;

// A description assembled from VERIFIED evidence, for the turn the interview is forced
// to wrap up and the model answers with no description of its own.
//
// Every claim here has already been matched against a real user turn by
// verifiedInterviewEvidence, so this is their own account — deduped, ordered and
// punctuated — never a model summary of it. Without this the clients fall back to
// joining the raw transcript, which is what the user then pays to have turned into
// bullets.
const descriptionFromEvidence = (ledger) => {
  const claims = (ledger?.evidence || []).map((e) => String(e?.claim || "").trim()).filter(Boolean);
  if (!claims.length) return "";
  return claims
    .map((c) => (/[.!?]$/.test(c) ? c : `${c}.`))
    .join(" ")
    .slice(0, 2000);
};

const declinedRequirementKeys = (draft) => {
  const rows = Array.isArray(draft?.skillDeclines) ? draft.skillDeclines : [];
  return new Set(
    rows
      .map((row) =>
        String(row?.name || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
};

// Everywhere in this person's history the hunt may ask about. Offered to the model as
// PLACES TO ASK — never as claims that anything happened there.
const huntContextsForDraft = (draft) => {
  const contexts = [];
  (draft?.experience || []).forEach((row) => {
    const label = [row?.title, row?.company].filter(Boolean).join(" at ");
    if (row?._sortId && label)
      contexts.push({
        sortId: String(row._sortId),
        kind: row?.entryType && row.entryType !== "job" ? String(row.entryType) : "experience",
        label,
      });
  });
  (draft?.projects || []).forEach((row) => {
    const label = String(row?.title || row?.name || "").trim();
    if (row?._sortId && label)
      contexts.push({ sortId: String(row._sortId), kind: "project", label });
  });
  (draft?.education || []).forEach((row, i) => {
    const label = [row?.degree || row?.field, row?.school].filter(Boolean).join(" at ");
    if (label) contexts.push({ sortId: `edu-${i}`, kind: "education", label });
  });
  (draft?.certifications || []).forEach((row, i) => {
    const label = String(row?.name || row?.title || "").trim();
    if (label) contexts.push({ sortId: `cert-${i}`, kind: "training", label });
  });
  return contexts.slice(0, 12);
};

// The two postures a hunt can take. They differ in ONE thing: whether Aria presses for an
// answer. She does when there is somewhere to put one — a live role interview, where a
// verdict becomes a bullet. Everywhere else the tap is curiosity ("what does this posting
// even mean by that?"), and pinning someone down for merely asking is the wrong trade.
// 'open' is the default because it is the posture that cannot do harm.
const HUNT_MODES = ["build", "open"];
const huntMode = (value) => (HUNT_MODES.includes(value) ? value : "open");

// One typed requirement, resolved by id, or null when it must not be raised at all.
//
// The decline check is the whole point of routing through a helper rather than reading
// `brief.requirements` inline: a clear "no" is honoured everywhere and permanently, and a
// new entry point that forgot it would be the way a refused requirement comes back.
const askableRequirement = (draft, brief, requirementId) => {
  const typed = Array.isArray(brief?.requirements) ? brief.requirements : [];
  const requirement = typed.find((item) => item?.id === requirementId);
  if (!requirement?.name) return null;
  if (declinedRequirementKeys(draft).has(String(requirement.name).toLowerCase())) return null;
  return {
    id: requirement.id,
    name: requirement.name,
    type: requirement.type || "skill",
    aliases: Array.isArray(requirement.aliases) ? requirement.aliases : [],
    proofSignals: Array.isArray(requirement.proofSignals) ? requirement.proofSignals : [],
  };
};

// Build the probe payload for ONE requirement, or null when it must not be asked.
const buildHuntProbe = (draft, brief, requirementId, mode = "open") => {
  const typed = Array.isArray(brief?.requirements) ? brief.requirements : [];
  const requirement = typed.find((item) => item?.id === requirementId);
  if (!requirement?.name) return null;
  // Already declined → never ask again, from any entry point.
  if (declinedRequirementKeys(draft).has(String(requirement.name).toLowerCase())) return null;
  return {
    requirementId: requirement.id,
    name: requirement.name,
    type: requirement.type || "skill",
    sourceText: String(requirement.sourceText || "").slice(0, 240),
    contexts: huntContextsForDraft(draft),
    mode: huntMode(mode),
  };
};

// When an entry interview closes, which of ITS unproven requirements are worth taking
// to the rest of the CV?
//
// Server-owned deliberately. `skillDeclines` is the one mechanism enforcing "never ask
// again after a clear no" across every surface, and a client that re-derived this list
// would be the way a declined skill comes back. The client is told WHAT to offer; it is
// never trusted to work out what may be asked.
//
// A requirement qualifies only when all three hold: this interview genuinely could not
// prove it HERE, it has never been hunted CV-wide before, and buildHuntProbe will
// actually open it (which is where the decline check lives). Capped low on purpose —
// the point is one useful offer at the end of a role, not a checklist to grind through.
const huntOffersForEntry = (draft, brief, requirementChecks = [], cap = 2) => {
  const unproven = (Array.isArray(requirementChecks) ? requirementChecks : []).filter(
    (row) => row?.requirementId && row?.status === "not_demonstrated"
  );
  if (!unproven.length) return [];

  const alreadyHunted = new Set(
    (Array.isArray(draft?.requirementProbes) ? draft.requirementProbes : [])
      .map((row) => String(row?.requirementId || ""))
      .filter(Boolean)
  );

  const offers = [];
  for (const row of unproven) {
    const requirementId = String(row.requirementId);
    if (alreadyHunted.has(requirementId)) continue;
    const probe = buildHuntProbe(draft, brief, requirementId);
    if (!probe) continue;
    // With only the entry we just interviewed to look at, a "hunt" would re-ask the
    // question the user has just answered. Two contexts is the minimum for it to mean
    // anything.
    if (probe.contexts.length < 2) continue;
    offers.push({ requirementId: probe.requirementId, name: probe.name });
    if (offers.length >= cap) break;
  }
  return offers;
};

// Verify what the model reported before ANY of it is written down.
//
// The rules are the ones that already protect the build interview, reused deliberately:
// the quote must appear verbatim in something the user actually typed, AND it must name
// the requirement (or an alias). A proof signal is not enough — "I prepared the weekly
// report" makes a spreadsheet tool plausible to ASK about; it does not prove they used
// one. A cross-history hunt invites exactly that mistake, so the check matters more here
// than anywhere else.
//
// Returns { level, verified, evidence } — `verified` false downgrades to 'deferred' and
// writes nothing.
//
// In a BUILD-posture hunt a decline needs no evidence: the user was asked a direct question
// and a decline only ever REMOVES things. That reasoning does not survive the OPEN posture.
// There the tap was curiosity — "what does this posting even mean by that?" — and a
// wandering answer must never be turned into a permanent "never ask again". So an open
// decline has to clear the same bar as a claim: the user's own words, naming the thing.
const verifyProbeResult = ({ probeResult, evidence = [], turns = [], probe }) => {
  const level = probeResult?.level;
  if (!aiService.HUNT_LEVELS.includes(level)) return null;
  // Missing mode defaults to the OPEN rule, matching buildHuntProbe. The unevidenced
  // shortcut has to be opted into explicitly, so a probe assembled anywhere else cannot
  // silence a requirement by omission.
  const isDecline = !aiService.HUNT_LEVELS_ADDABLE.includes(level);
  if (isDecline && probe?.mode === "build") {
    return { level, verified: true, evidence: null };
  }

  const index = probeResult.evidenceIndex;
  const item = Number.isInteger(index) ? evidence[index] : null;
  const quote = String(item?.sourceQuote || "").trim();
  if (!quote) return { level, verified: false, evidence: null };

  // The quote must be something they really typed.
  const normalizedQuote = normalizedEvidenceText(quote);
  const saidIt = (turns || []).some(
    (turn) => turn?.who === "user" && normalizedEvidenceText(turn.text).includes(normalizedQuote)
  );
  if (!saidIt || !normalizedQuote) return { level, verified: false, evidence: null };

  // …and it must NAME the thing, not merely be adjacent to it.
  const terms = [probe?.name, ...(probe?.aliases || [])]
    .map(normalizedEvidenceText)
    .filter(Boolean);
  const names = terms.some((term) => normalizedQuote.includes(term));
  if (!names) return { level, verified: false, evidence: null };

  return { level, verified: true, evidence: item };
};

// Narrow the CV-wide open requirements to the few that are most plausible for the
// entry Aria is interviewing NOW. The model still makes the final plausibility call;
// this deterministic pre-filter stops a long JD from turning every role into the same
// keyword interrogation.
const targetRequirementsForEntry = (draft, brief, entry, turns = [], cap = 3) => {
  const typed = Array.isArray(brief?.requirements) ? brief.requirements : [];
  const declined = declinedRequirementKeys(draft);
  const openSkills = openMustHavesFromDraft(draft, brief, Math.max(cap * 3, 6));
  // Responsibilities are not skill chips, but they are valuable interview leads. They
  // join the candidate pool as typed requirements and can rank only when this role's
  // title/answers make them plausible.
  const responsibilityLeads = typed
    .filter((item) => item?.type === "responsibility" && item?.name)
    .map((item) => ({ name: item.name, importance: item.priority || "must_have" }));
  const open = [...openSkills, ...responsibilityLeads]
    .filter(
      (item, index, items) =>
        items.findIndex(
          (candidate) =>
            String(candidate.name || "").toLowerCase() === String(item.name || "").toLowerCase()
        ) === index
    )
    // A clear "no" is honoured everywhere, permanently. Being asked again about something
    // you have already said you've never done is the fastest way to feel unheard.
    .filter((item) => !declined.has(String(item.name || "").toLowerCase()));
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

// The bullets an entry already carries, as clean lines. `description` is one string with
// a bullet per line and a leading glyph that varies (•, -, *) depending on what wrote it.
// Capped: a role that has collected thirty of these is exactly the role this matters most
// for, and also the one whose full list would crowd out the prompt it is being added to.
const bulletsOf = (entry, cap = 24) =>
  String(entry?.description || "")
    .split("\n")
    .map((line) => line.replace(/^[\s•\-*]+/, "").trim())
    .filter(Boolean)
    .slice(0, cap);

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
// ── A FIGURE HAS TO HAVE BEEN SAID ──────────────────────────────────────────
//
// The verifier below checked the sourceQuote and stopped there. The `tools` and `metrics`
// riding alongside it passed through untouched — and those two are exactly what
// generateBulletsFromDescription puts in the writer's prompt, under the headings
// "CONFIRMED TOOLS" and "USER-STATED METRICS". Neither word was true of them. Confirmed by
// direct call: a real quote carrying metrics ["cut downtime by 18%"] and tools ["Power BI"]
// came back with both intact, though neither appeared anywhere in the conversation.
//
// That is the shortest route a fabricated number has onto a finished CV, and it widens the
// longer an interview runs.
//
// THE RULE, chosen over the stricter same-sentence one: the figure must appear SOMEWHERE
// in what the candidate typed, not necessarily in the sentence being cited. Anything
// conjured from nothing is still caught, while Aria's own rephrasing survives — she
// routinely lifts a number out of the turn it was said in and into a tidier claim, and
// same-sentence matching would have thrown away the real achievement with the invented one.
const NUMBER_WORDS = Object.freeze({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
  million: 1000000,
});

const FIGURE = /\d[\d,]*(?:\.\d+)?/g;
// "1,200" and "1200.0" are the same figure as "1200". Compared in one canonical form so a
// thousands separator or a trailing zero cannot make a real number look invented.
const canonicalFigure = (value) => String(value).replace(/,/g, "").replace(/\.0+$/, "");

// Every figure the candidate used, in digits — including the ones they spelled out, since
// "about eighteen percent" and "18%" are the same claim.
const figuresSaid = (texts) => {
  const found = new Set();
  texts.forEach((text) => {
    const lower = String(text || "").toLowerCase();
    (lower.match(FIGURE) || []).forEach((n) => found.add(canonicalFigure(n)));
    const words = lower.split(/[^a-z]+/).filter(Boolean);
    words.forEach((word, i) => {
      const n = NUMBER_WORDS[word];
      if (n === undefined) return;
      found.add(String(n));
      // One compound, "twenty five" / "twenty-five" (both split to the same two words).
      // Anything longer is rarer in speech than the false rejections parsing it would cost.
      const next = NUMBER_WORDS[words[i + 1]];
      if (n >= 20 && n <= 90 && n % 10 === 0 && next !== undefined && next < 10) {
        found.add(String(n + next));
      }
    });
  });
  return found;
};

// A metric with NO figure in it is prose, not a claim about size ("reduced downtime"), so
// there is nothing to check and nothing to fabricate. One with figures must have all of
// them accounted for: "6-hourly checks across 30 wells" is not supported by a candidate
// who only ever said six.
const metricWasSaid = (metric, said) => {
  const figures = String(metric).match(FIGURE);
  if (!figures) return true;
  return figures.every((n) => said.has(canonicalFigure(n)));
};

// A tool is a NAME, so it has to have been named. Matched squashed as well as plain, so
// "Power BI", "PowerBI" and "power-bi" are one thing — per turn rather than against the
// joined transcript, or the end of one answer and the start of the next could combine into
// a tool nobody mentioned.
const squash = (value) => normalizedEvidenceText(value).replace(/[^a-z0-9]/g, "");
const toolWasSaid = (tool, userTurns) => {
  const plain = normalizedEvidenceText(tool);
  const tight = squash(tool);
  if (!plain || !tight) return false;
  return userTurns.some(
    (turn) => turn.normalized.includes(plain) || squash(turn.text).includes(tight)
  );
};

const verifiedInterviewEvidence = (rawEvidence, turns, requirements = []) => {
  const userTurns = (turns || [])
    .filter((m) => m?.who === "user" && m.text)
    .map((m, index) => ({
      index,
      text: String(m.text).trim(),
      normalized: normalizedEvidenceText(m.text),
    }));
  // Every figure the candidate used anywhere in this window, computed once rather than per
  // evidence item. This is the "somewhere in the conversation" half of the rule above.
  const saidFigures = figuresSaid(userTurns.map((turn) => turn.text));
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
      // Filtered BEFORE evidenceText is built below, so an unsaid tool cannot go on to
      // satisfy a requirement either — the same word would otherwise tick "Power BI" on
      // the checklist on the strength of the model having typed it.
      const tools = cleanEvidenceList(item?.tools, 10).filter((tool) =>
        toolWasSaid(tool, userTurns)
      );
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
        // `outcomes` and `skills` are deliberately NOT filtered: neither reaches the
        // bullet writer's prompt (only the quote, the claim, tools and metrics do), so
        // neither can put a number or a product name into a finished bullet. Filtering
        // them would strip legitimate paraphrase for no gain in truthfulness.
        outcomes: cleanEvidenceList(item?.outcomes, 6),
        metrics: cleanEvidenceList(item?.metrics, 6).filter((metric) =>
          metricWasSaid(metric, saidFigures)
        ),
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
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    return res.status(400).json({ message: "count must be an integer between 1 and 8" });
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

    // No JD? Resolve the all-rounder context rather than leaving the writer with nothing
    // but a job title. Non-fatal for the same reason the brief is.
    let noJd = null;
    if (!brief) {
      try {
        noJd = await resolveNoJdContext(draft, meta);
      } catch (noJdErr) {
        console.error(
          "Coach resolveNoJdContext error (generateBullets, continuing):",
          noJdErr.message
        );
      }
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
    // Worst-case cost, for the balance pre-check only — the ACTUAL charge is computed
    // after generation from however many bullets are really delivered (see below).
    const maxCost = n * perBullet;

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
    if (!isFreeReroll && subscription.availableCredits(user) < maxCost) {
      return res.status(403).json({
        code: "INSUFFICIENT_CREDITS",
        message: "Insufficient credits",
        required: maxCost,
        remainingCredits: subscription.availableCredits(user),
      });
    }

    let bulletDetails;
    try {
      bulletDetails = await aiService.generateBulletsFromDescription(desc, n, {
        // WHAT THIS ROLE ALREADY CLAIMS.
        //
        // Applying bullets is a checkpoint, not an ending: the user carries on talking
        // about the same role, and the coach's transcript restarts at the fresh `pinrole`
        // marker — so round two arrives with no idea what round one produced. The writer
        // then received a description, an evidence ledger and nothing at all saying "this
        // role already says you handed equipment off for FIT checks."
        //
        // Measured on a real CV: a Wireline Field Operator role with 40 applied bullets
        // where #33–#38 are near-copies of #9–#16, plus the same expired-certification
        // catch told three times. No better model fixes that — nothing can avoid
        // repeating what it cannot see.
        existingBullets: bulletsOf(entry),
        brief,
        role: entry.title || (section === "experience" ? "this role" : "this project"),
        section,
        evidenceLedger,
        // The same stage the interview ran on, so the writer can't undo the interview's
        // care — a grad interviewed without metric pressure must not be written up to a
        // metric-shaped rubric. Body value wins, else the pick persisted on the draft.
        stage: aiService.resolveCareerStage({ stage: req.body?.stage, draft }),
        noJd,
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
    // Citation enforcement + a bounded backfill retry already ran inside
    // generateBulletsFromDescription, so whatever comes back here is ledger-clean. Charge
    // for what was ACTUALLY delivered, not what was requested — a thin description can
    // legitimately fall short of `n` well-cited bullets, and that's honest, not an error.
    if (!Array.isArray(bulletDetails) || bulletDetails.length === 0) {
      return res.status(502).json({ message: "Couldn't generate right now. Please try again." });
    }
    const cost = bulletDetails.length * perBullet;
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
        description: `Aria bullets (${bulletDetails.length})`,
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
    const willMeter = modelSelection.alwaysMeters(tier) || !subscription.isPaidActive(user);
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
  if (modelSelection.alwaysMeters(tier)) {
    const r = await modelSelection.chargeForModel(user, cost, tier, {
      type: TRANSACTION_TYPES.ARIA_CHAT,
      description: `Aria chat (${tier} model)`,
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
  modelSelection.alwaysMeters(tier) || (pre.willCharge && !subscription.isPaidActive(user));

// Refuse a turn the user can't pay for. The two tiers fail for DIFFERENT reasons and
// must not share a message: a LIGHT user has genuinely burned the day's free pool and
// their credits ("come back tomorrow" is true). A FLAGSHIP user may have the whole free
// pool left — Pro simply never rides it — so "you've used today's free chats" is wrong,
// and it hides the actual way out: switch back to Standard, which is still free.
const refuseChatTurn = (res, { tier, cost, user, pre, building = false }) => {
  if (modelSelection.alwaysMeters(tier)) {
    return res.status(403).json({
      code: "INSUFFICIENT_CREDITS",
      message: building
        ? "Building with a paid model costs credits. Switch to Basic — it's free — or top up."
        : "This model costs credits per message. Switch to Basic — it's free — or top up.",
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
  const { draftId, currentStepId, question, model, screen } = req.body || {};
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
        // What the user is looking at. Client-supplied free text bound for a SYSTEM
        // prompt, so it goes through the bounding pass; a malformed one becomes null and
        // the prompt reads exactly as it did before this existed.
        screen: sanitizeScreen(screen),
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
// THE SAME "THOROUGH OR QUICK" THE USER ALREADY CHOSE FOR CALLS.
//
// Reported: "I was being interviewed a lot." Not a bug — the prompt says not to wrap up
// while a plausibly relevant requirement is unexplored, and a model that follows
// instructions more literally keeps going for longer. But ten turns is a long time to be
// asked questions, and which side of that trade someone wants is not ours to guess.
//
// The setting already existed and was already on screen: the chip under the composer
// reads "Thorough · Direct", it is saved on the account, and until now it governed CALLS
// ONLY. Someone could set it, watch it sit there through a typed interview, and wonder
// what it was for. This is that control finally meaning what it says.
const STUDIO_INTERVIEW_TURN_CAP_QUICK = 6;

// @desc    Aria's UNIFIED chat — ONE front door. Focus-aware + intent-classified on
//          the CHEAP base model: a focused 'building'/'ready' turn is FREE (build-with);
//          a general question ('answer') spends the daily allowance. Charging is
//          SMART PER-MESSAGE. Same guardrails/allowance as /coach/ask.
// @route   POST /api/coach/chat
// @access  Private (job-seekers only — not CV-agent client CVs)
const chat = async (req, res) => {
  const {
    draftId,
    currentStepId,
    messages,
    focus,
    buildTurns,
    stage,
    studioInterview,
    // The card on screen: { id, title, body, options }. Bounded before use — see below.
    screen,
    // { requirementId } — runs the cross-history hunt instead of the entry interview.
    probe: probeRequest,
  } = req.body || {};
  if (!draftId) {
    return res.status(400).json({ message: "draftId is required" });
  }
  if (focus && !(["experience", "project"].includes(focus.section) && focus.sortId)) {
    return res
      .status(400)
      .json({ message: "focus must be { section: 'experience'|'project', sortId }" });
  }
  // A PROBE opens its own turn. Tapping a requirement is the trigger — there is no user
  // message behind it, and the client must not invent one to satisfy this check (it used to
  // push a sentence into the user's own bubble, which read as something they had typed).
  // Every non-probe turn keeps both rules exactly as they were.
  const probeOpensTurn = !!probeRequest?.requirementId;

  if (!Array.isArray(messages) || (messages.length === 0 && !probeOpensTurn)) {
    return res.status(400).json({ message: "messages must be a non-empty array" });
  }
  // Normalize + validate: the LAST message must be the user's new turn.
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.who === "aria" || m.who === "user") && typeof m.text === "string")
    .map((m) => ({ who: m.who, text: m.text.trim() }))
    .filter((m) => m.text);
  const last = turns[turns.length - 1];
  // A SPOKEN INTERVIEW DOES NOT END ON THE USER'S WORD.
  //
  // This rule was written for typing, where the request IS the user's new turn, so the last
  // message is theirs by construction. A call is the other way round: Aria asks the questions,
  // so she is usually the last voice on it — always when the clock runs out mid-question, and
  // always when the connection drops. The whole transcript is then posted once to be wrapped
  // up, and this 400'd it before anything else ran. Observed on three real calls: the one that
  // happened to end on the candidate's answer produced bullets, the two that ended on Aria's
  // question produced "couldn't generate bullets" — after the minutes had been spent.
  //
  // A wrap-up is not a turn awaiting a reply. It asks for a summary of a finished conversation,
  // so there is nothing for the last message to be. It still has to HAVE the candidate in it —
  // a recording of Aria talking to herself has nothing to write bullets from.
  const isStudioWrapUp =
    studioInterview === true &&
    !!focus &&
    Number(buildTurns) >= STUDIO_INTERVIEW_TURN_CAP &&
    turns.some((t) => t.who === "user");
  if ((!last || last.who !== "user") && !probeOpensTurn && !isStudioWrapUp) {
    return res.status(400).json({ message: "The last message must be the user's turn." });
  }
  if (last && last.text.length > 800) {
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
    //
    // Normalised, never trusted: `depth` arrives in the request body and an unlisted value
    // falls back to the default rather than reaching a prompt or lengthening an interview
    // someone did not ask to lengthen.
    const { depth } = normalizeCallSettings({ depth: req.body?.depth });
    const studioCap =
      depth === "quick" ? STUDIO_INTERVIEW_TURN_CAP_QUICK : STUDIO_INTERVIEW_TURN_CAP;
    const turnCap = studioInterview === true ? studioCap : INTERVIEW_TURN_CAP;
    const mustFinish = !!focus && Number(buildTurns) >= turnCap;

    // Route the turn through the selected model (multi-provider dispatcher).
    //
    // The id is minted HERE, before the call, and returned to the client as `feedbackId`
    // so a 👍/👎 on this specific reply lands on the row that produced it. Resolving it
    // afterwards is not possible: the audit write is fire-and-forget, and "the newest log
    // for this user and operation" would misfile a rating on any message but the last.
    const feedbackId = new mongoose.Types.ObjectId();
    const meta = {
      userId: req.user.id,
      operation: "coachChatTurn",
      modelId,
      lang: req.lang,
      logId: feedbackId,
    };
    const targetTitle = (draft.targetJob?.title || draft.targetJob?.brief?.role || "").trim();
    // The whole CV, bounded — not a count of it. During a focused interview Aria was
    // asking about role 3 while knowing only that roles 1 and 2 existed, so she re-asked
    // things already answered elsewhere and could not have spotted a contradiction if one
    // appeared. What she may DO with this is fenced prompt-side (read, never write from).
    const cvSummary = aiService.cvDigest(draft, targetTitle);

    let brief = null;
    try {
      brief = await resolveDraftBrief(draft, meta);
    } catch (briefErr) {
      console.error("Coach chat resolveDraftBrief error (brief-less):", briefErr.message);
    }

    // No JD? The interviewer gets the all-rounder framing plus soft trade leads, instead
    // of the bare string "TARGET: none". Non-fatal.
    let noJd = null;
    if (!brief) {
      try {
        noJd = await resolveNoJdContext(draft, meta);
      } catch (noJdErr) {
        console.error("Coach chat resolveNoJdContext error (continuing):", noJdErr.message);
      }
    }

    const stepLabel = STEP_LABELS[currentStepId] || "your CV";
    // Bounded once and named, because it is needed twice: the prompt is told what is on
    // screen, and the answer that comes back is checked against it — an options card may
    // only ever name a choice the user can actually see.
    const screenContext = sanitizeScreen(screen);
    // Studio can unpack several activities across ten user turns, so retain the opening
    // activity list for that whole interview. Other coach surfaces keep the smaller window.
    const window = turns.slice(-(studioInterview === true ? 22 : 12));
    // The role's still-uncovered must-haves, narrowed to three candidates ranked by
    // signals in THIS entry and THIS conversation. The model must still skip anything
    // implausible; ranking is guidance, never evidence.
    let openMustHaves = focus ? targetRequirementsForEntry(draft, brief, entry, window, 3) : [];

    // ── "I DID THIS HERE TOO" ────────────────────────────────────────────────
    //
    // The user has tapped a requirement that is ALREADY covered — proved at some other
    // entry — and wants it raised against the one they are building now. Real need: a CV
    // is read role by role, and a requirement proved only at a 2019 job leaves the most
    // recent role, the one a recruiter reads first, silent on it.
    //
    // Deliberately NOT the cross-history hunt below, which would be the obvious reuse and
    // is wrong twice over. That path files evidence under whichever entry the USER names
    // (its own comment: "usually NOT the entry this conversation started from"), and on a
    // clear no it writes a CV-WIDE decline that silences the requirement on every surface.
    // So tapping this and then saying "actually, not at this job" would delete a
    // requirement the user genuinely holds elsewhere. Nothing about that is recoverable
    // from the UI.
    //
    // Instead it becomes a forced, entry-scoped confirmation: the same mechanism the
    // interview already uses to raise a JD requirement, aimed by the user rather than by
    // the ranker. Evidence banks under THIS entry through the ordinary path, and a "no"
    // silences nothing — it is one question about one job, not a verdict on their career.
    const alsoHere =
      focus && probeRequest?.scope === "entry"
        ? askableRequirement(draft, brief, probeRequest.requirementId)
        : null;
    if (alsoHere) {
      // Prepended rather than replacing the list: it leads the turn, and being IN the list
      // is also what lets verifiedInterviewEvidence link what they say back to this
      // requirement. Without that the answer banks with no connection to it, the role
      // gets no credit on the checklist, and the tick keeps naming the older job.
      openMustHaves = [
        { name: alsoHere.name, importance: "must_have", id: alsoHere.id, type: alsoHere.type },
        ...openMustHaves.filter((item) => item?.id !== alsoHere.id),
      ];
    }

    const requiredProbe = alsoHere
      ? { ...alsoHere, alreadyCovered: true }
      : focus && !mustFinish
        ? selectRequiredRequirementProbe(openMustHaves, window, buildTurns)
        : null;

    // The CROSS-HISTORY HUNT for one requirement. Null when the id is unknown or the user
    // has already declined it — buildHuntProbe refuses rather than asking again. Skipped
    // entirely for an entry-scoped tap, which must never reach the decline-writing path.
    const probe =
      probeRequest?.requirementId && !alsoHere
        ? buildHuntProbe(draft, brief, probeRequest.requirementId, probeRequest.mode)
        : null;

    // NO focus → every turn is a general answer (metered like /coach/ask). Pre-check
    // the balance BEFORE spending an AI call the user can't pay for — but only when the
    // turn will actually meter (a paid light user is unlimited and never blocked here;
    // a flagship user always meters, pool or no pool).
    if (
      !focus &&
      !probe &&
      turnWillMeter(user, pre, tier) &&
      subscription.availableCredits(user) < cost
    ) {
      return refuseChatTurn(res, { tier, cost, user, pre });
    }

    // Build-with is free but bounded — block BEFORE spending an AI call once the
    // daily anti-abuse ceiling is hit. Client-supplied buildTurns/mustFinish above
    // is a conversation-quality cap, not a cost control; this is the real backstop.
    // A hunt turn is free like a build turn, so it draws on the same anti-abuse ceiling —
    // otherwise it would be an uncapped free AI call.
    if ((focus || probe) && preBuild.exhausted) {
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
    if (focus && modelSelection.alwaysMeters(tier) && subscription.availableCredits(user) < cost) {
      return refuseChatTurn(res, { tier, cost, user, pre, building: true });
    }

    let result;
    // Set when the model's answer came back unreadable and we recovered a fragment. It
    // suppresses charging below: a turn we could not read is not a turn to bill for.
    let turnFailed = false;
    try {
      result = await aiService.coachChatTurn({
        messages: window,
        focus: !!focus,
        // Thorough or quick — already normalised above, and the same choice that shapes a
        // CALL. The cap alone would only gag her at the tenth turn; this is what makes a
        // quick interview actually feel quick rather than abruptly cut off.
        depth,
        entryTitle: entry?.title || "this role",
        entryCompany: (entry?.company || "").trim(),
        entryType: entry?.entryType || "",
        // What this entry ALREADY says. The coach's transcript restarts at the newest
        // `pinrole`, so a second round on the same role opens blank; the CV digest that
        // travels with it squeezes the whole role into 140 characters, which on a role
        // with forty bullets is one truncated line. Without this she re-asks what she
        // already has — observed, and the direct cause of duplicate bullets.
        entryBullets: focus ? bulletsOf(entry) : [],
        section: focus?.section || "",
        // Career stage forks the experience coaching: explicit chip choice wins; else
        // inferred from the draft (real job → experienced, else entry-level 'grad').
        stage: aiService.resolveCareerStage({ stage, draft }),
        stepLabel,
        // stepLabel says which SECTION they are on; this says which CARD is in front of
        // them, which is what a question like "explain the three options" is actually
        // about. Bounded first: it is request-body free text headed for a system prompt.
        screen: screenContext,
        // The scorecard from the same window she is sitting in. Passed as-is; the service
        // bounds it and stamps it with its own date, because a scan is a snapshot and the
        // CV may have moved since.
        scan: draft.studioScan,
        // Nine deterministic recruiter checks. Computed here rather than in the AI service
        // so that service keeps no dependency on the ATS coach — and it costs nothing:
        // no model call, no query, just a pass over the draft already in memory.
        redFlags: detectRedFlags(draft),
        cvSummary,
        brief,
        noJd,
        openMustHaves,
        requiredProbe,
        probe,
        mustFinish,
        meta,
      });
    } catch (aiErr) {
      if (aiErr instanceof aiService.AIUnavailableError) {
        return res
          .status(503)
          .json({ message: "AI is not configured right now. Please try again later." });
      }
      // TWO DIFFERENT FAILURES ARRIVE HERE, and treating them as one is what put a raw
      // JSON object into a user's chat.
      //
      //   (a) The model ignored the JSON instruction and answered in plain prose. That
      //       answer is genuinely useful, so it is delivered rather than making the user
      //       retype the same thing. This is the case the fallback was written for.
      //
      //   (b) The model ran out of budget mid-object. `response` is then a half-written
      //       JSON literal, which the old code assigned straight to `reply`. `reply` is
      //       the FIRST key the prompt asks for, so it is usually complete inside the
      //       fragment: salvage it, and when there is nothing to salvage say so honestly
      //       rather than showing the wreckage.
      if (aiErr instanceof aiService.AIJSONParseError && aiErr.response) {
        if (aiErr.truncated || looksLikeJsonObject(aiErr.response)) {
          const salvaged = salvageJsonReply(aiErr.response);
          logger.warn(
            `Coach chat AI output truncated/unparseable (user=${req.user.id}, model=${modelId}, salvaged=${salvaged.length} chars)`
          );
          // Too little to be worth showing. Returning here is deliberate: falling through
          // with an empty reply would push a blank bubble into the transcript — where it
          // would be persisted and replayed to the model on every later turn — and bill
          // for it.
          if (salvaged.length < 20) {
            return res
              .status(502)
              .json({ message: "That answer got cut off. Say that again and I'll pick it up." });
          }
          turnFailed = true;
          result = {
            reply: salvaged,
            // Never 'ready'. The `description` a ready turn exists to produce is precisely
            // what was lost, and claiming ready would hand the client an empty one and
            // start a bullet generation the user PAYS for.
            intent: focus ? "building" : "answer",
            description: "",
            suggestions: [],
            exampleAnswers: [],
            suggestionsLabel: "",
          };
        } else {
          logger.warn(
            `Coach chat received non-JSON AI output; using text fallback (user=${req.user.id}, model=${modelId})`
          );
          result = {
            reply: aiErr.response,
            intent: focus ? "building" : "answer",
            description: "",
            suggestions: [],
            exampleAnswers: [],
            suggestionsLabel: "",
          };
        }
      } else {
        console.error("Coach chat AI error:", aiErr.message);
        return res.status(502).json({ message: "Couldn't continue right now. Please try again." });
      }
    }

    // No focus → always a general answer; focused → trust the classifier.
    // A HUNT turn is an interview turn, not a general question: it is Aria asking, and
    // charging someone to be asked whether they have a skill would be indefensible. It
    // takes the same free-on-light path build-with does.
    const intent = focus || probe ? result.intent : "answer";

    // SMART PER-MESSAGE charging: a general 'answer' spends the chat allowance;
    // 'building'/'ready' (focused build-with) is free on LIGHT, metered on FLAGSHIP.
    let charged = false;
    let freeRemaining = Math.max(0, FREE_DAILY_CHATS - pre.used);
    // A turn we could not read is not a turn to bill for. The old code charged for the
    // raw-JSON dump exactly as it would for a good answer.
    if (turnFailed) {
      // nothing spent
    } else if (intent === "answer") {
      const c = await commitChatTurn(user, pre, cost, tier);
      if (c.insufficient) {
        // They can't pay for a general answer — don't leak the reply. (On LIGHT they
        // can still build for free on a focused role.)
        return refuseChatTurn(res, { tier, cost, user, pre });
      }
      charged = c.charged;
      freeRemaining = c.freeRemaining;
    } else if (focus || probe) {
      // Build-with is FREE on the LIGHT model — that's the point of Aria Studio.
      // FLAGSHIP meters even here: an unlimited Sonnet interview is exactly the
      // cost blow-out modelSelection.service is written to prevent.
      if (modelSelection.alwaysMeters(tier)) {
        const r = await modelSelection.chargeForModel(user, cost, tier, {
          type: TRANSACTION_TYPES.ARIA_CHAT,
          description: `Aria build-with (${tier} model)`,
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
    // Requirements this entry could not prove that are worth taking CV-wide. Filled only
    // when the interview closes; [] on every other turn.
    let huntOffers = [];
    // ── The hunt's answer ────────────────────────────────────────────────────
    // Verified, then written. A rung the user reached is never trusted on the model's
    // say-so: 'regular'/'basic'/'coursework' need their own words, naming the thing.
    let probeOutcome = null;
    if (probe && result.probeResult) {
      const verdict = verifyProbeResult({
        probeResult: result.probeResult,
        evidence: result.evidence,
        turns: window,
        probe,
      });
      if (verdict) {
        const addable = aiService.HUNT_LEVELS_ADDABLE.includes(verdict.level);
        // `verified` now gates BOTH directions. It always gated a claim; it gates a decline
        // too in the open posture, where verifyProbeResult refuses an unbacked "never".
        // Unverified either way → 'deferred': the probe is recorded as asked, but nothing
        // enters the CV and nothing is silenced.
        const status = verdict.verified ? (addable ? "confirmed" : "declined") : "deferred";

        // File the evidence under the entry the USER says it happened in — which is
        // usually NOT the entry this conversation started from. That is the whole point of
        // hunting across their history, and it means a confirmation here also strengthens
        // that role's bullets, not just the skills list.
        const contextSortId = result.probeResult.contextSortId || null;
        if (status === "confirmed" && verdict.evidence && contextSortId) {
          const current = draft.coachEvidence?.toObject
            ? draft.coachEvidence.toObject()
            : draft.coachEvidence || {};
          const bucket = current[contextSortId] || { evidence: [], requirementChecks: [] };
          const banked = {
            ...verdict.evidence,
            id: evidenceIdFor(verdict.evidence.sourceQuote, verdict.evidence.claim),
            requirementIds: [probe.requirementId],
            fromHunt: true,
          };
          current[contextSortId] = {
            ...bucket,
            evidence: [...(bucket.evidence || []), banked],
            updatedAt: new Date().toISOString(),
          };
          draft.coachEvidence = current;
          if (typeof draft.markModified === "function") draft.markModified("coachEvidence");
          probeOutcome = { ...result.probeResult, status, evidenceId: banked.id };
        } else {
          probeOutcome = { ...result.probeResult, status, evidenceId: null };
        }

        // Record the probe, and — for a clear no — the decline that stops every surface
        // asking again.
        const probes = Array.isArray(draft.requirementProbes) ? draft.requirementProbes : [];
        const existing = probes.find((row) => row.requirementId === probe.requirementId);
        const patch = {
          requirementId: probe.requirementId,
          name: probe.name,
          status,
          level: verdict.level,
          contextSortId: probeOutcome.evidenceId ? contextSortId : null,
          contextKind: result.probeResult.contextKind || null,
          evidenceId: probeOutcome.evidenceId,
          answeredAt: new Date(),
        };
        if (existing) Object.assign(existing, patch);
        else draft.requirementProbes = [...probes, { ...patch, askedAt: new Date() }];

        if (status === "declined") {
          const declines = Array.isArray(draft.skillDeclines) ? draft.skillDeclines : [];
          if (!declines.some((row) => row.requirementId === probe.requirementId)) {
            draft.skillDeclines = [
              ...declines,
              {
                requirementId: probe.requirementId,
                name: probe.name,
                level: verdict.level,
                source: "interview",
                at: new Date(),
              },
            ];
          }
        }
        if (typeof draft.save === "function") await draft.save();
      }
    }

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
      // The cross-history hunt files its confirmations into THIS SAME bucket (see the probe
      // branch above, which stamps `fromHunt: true`). Replacing the bucket wholesale threw
      // those away the moment the user re-interviewed the role — silently un-proving a
      // requirement they had already been asked for separately and confirmed.
      //
      // That reasoning holds for EVERY earlier finding, not only the hunt's.
      //
      // A round used to replace the bucket and keep only the hunt items, so the moment the
      // user applied bullets and carried on — which the flow explicitly invites — round
      // one's verified evidence vanished. With it went the reason under each tick on "what
      // this job asks for": a requirement stayed covered by the CV text while the "from
      // what you told me" line that justified it quietly disappeared, and a confirmed
      // check whose evidence was gone stopped resolving at all.
      //
      // So: fresh findings WIN on collision (a re-told answer keeps its newest wording),
      // and everything earlier rides along behind them. Both write sites derive `id` the
      // same way (sha1 of the normalised quote + claim), so the same answer found twice is
      // one entry, not two. Capped, because this now accumulates across rounds and the
      // whole bucket goes into a prompt.
      const prior = current[focus.sortId] || {};
      const freshIds = new Set(evidenceLedger.evidence.map((e) => e.id));
      const carried = (prior.evidence || []).filter((e) => e?.id && !freshIds.has(e.id));
      if (carried.length) {
        evidenceLedger.evidence = [...evidenceLedger.evidence, ...carried].slice(0, 40);
      }
      // The checks follow the evidence, for the same reason and with the same rule: a
      // requirement confirmed in an earlier round stays confirmed unless THIS round has
      // something newer to say about it. Dropped if its evidence did not survive the cap,
      // so a check can never point at an id that is no longer there.
      const keptEvidenceIds = new Set(evidenceLedger.evidence.map((e) => e.id));
      const freshCheckIds = new Set(
        (evidenceLedger.requirementChecks || []).map((c) => c.requirementId)
      );
      const carriedChecks = (prior.requirementChecks || []).filter(
        (check) =>
          check?.requirementId &&
          !freshCheckIds.has(check.requirementId) &&
          (!check.evidenceId || keptEvidenceIds.has(check.evidenceId))
      );
      if (carriedChecks.length) {
        evidenceLedger.requirementChecks = [
          ...(evidenceLedger.requirementChecks || []),
          ...carriedChecks,
        ];
      }
      draft.coachEvidence = { ...current, [focus.sortId]: evidenceLedger };
      if (typeof draft.markModified === "function") draft.markModified("coachEvidence");
      if (typeof draft.save === "function") await draft.save();
      // Computed AFTER the save so `requirementProbes` is current — a hunt run earlier in
      // this same session must not be offered a second time.
      huntOffers = huntOffersForEntry(draft, brief, requirementChecks);
    }

    return res.json({
      reply: result.reply,
      // What a 👍/👎 on this reply attaches to. See the mint above.
      feedbackId: feedbackId.toString(),
      intent,
      readyToDraft,
      // Keyed off readyToDraft, not `intent`. The turn cap FORCES the wrap-up server-side,
      // so a model that answered 'building' on that turn used to produce readyToDraft:true
      // with an empty description — and both clients quietly joined the raw user turns
      // instead, meaning the user paid for bullets written from a transcript dump. If the
      // model gives us nothing, we assemble one from evidence already verified against
      // their own words.
      description: readyToDraft
        ? result.description || descriptionFromEvidence(evidenceLedger)
        : "",
      evidenceLedger,
      // The hunt's verified outcome: which rung, whether it was accepted, and where the
      // evidence was filed. null on an ordinary turn, or while the user hasn't answered.
      probeResult: probeOutcome,
      // Requirements this entry could not prove that are worth looking for elsewhere in
      // the CV. Empty except on the turn an entry interview closes.
      huntOffers,
      // The designed shape of this answer, when it earned one. Null on a build-with
      // turn, on ordinary prose, and — deliberately — whenever the model named a choice
      // that is not on the card: a labelled row is a stronger claim than a sentence, so a
      // layout that does not check out is dropped rather than half-drawn.
      ...(intent === "answer"
        ? (() => {
            const shaped = sanitizeAnswerLayout({
              layout: result.layout,
              blocks: result.blocks,
              screenOptions: screenContext?.options || [],
            });
            return { layout: shaped?.layout || "prose", blocks: shaped?.blocks || [] };
          })()
        : { layout: "prose", blocks: [] }),
      // Answer scaffolds — only while building (Aria just asked a follow-up).
      suggestions: intent === "building" ? result.suggestions || [] : [],
      exampleAnswers: intent === "building" ? result.exampleAnswers || [] : [],
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
// @desc   Record that the user has NO target job, and cache the inferred role-family
//         vocabulary that stands in for a Role Brief.
// @route  POST /api/coach/no-target
// @access Private
//
// "Not yet — build a strong all-rounder" used to be a chat line that changed nothing.
// This is the state behind it. FREE: inferRoleKeywords is extraction-cached and runs on
// the cheap base model, and charging someone for declining to paste a JD would be absurd.
const setNoTarget = async (req, res) => {
  const { draftId, roleFamily } = req.body || {};
  if (!draftId) return res.status(400).json({ message: "draftId is required" });

  try {
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ message: "Invalid draftId format" });
    }
    const draft = await DraftCV.findById(draftId);
    if (!draft) return res.status(404).json({ message: "CV not found" });
    if (draft.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to edit this CV" });
    }
    // A real JD outranks this. Declining after pasting one would be contradictory state.
    if ((draft.targetJob?.description || "").trim()) {
      return res.status(409).json({ message: "This CV already has a target job." });
    }

    if (!draft.targetJob) draft.targetJob = {};
    const family = String(roleFamily || "").trim();
    draft.targetJob.noJd = {
      ...(draft.targetJob.noJd?.toObject
        ? draft.targetJob.noJd.toObject()
        : draft.targetJob.noJd || {}),
      declined: true,
      declinedAt: new Date(),
      ...(family ? { roleFamily: family } : {}),
    };
    await draft.save();

    // Best-effort: a failed inference must still leave `declined` recorded, because that
    // is the part the rest of the flow branches on.
    let noJd = null;
    try {
      noJd = await resolveNoJdContext(draft, {
        userId: req.user.id,
        operation: "coachNoTarget",
        lang: req.lang,
      });
    } catch (inferErr) {
      console.error("Coach setNoTarget inference failed (declined still saved):", inferErr.message);
    }

    return res.json({ noJd: noJd || { roleFamily: family, keywords: [] } });
  } catch (error) {
    console.error("Coach setNoTarget error:", error.message);
    return res.status(500).json({ message: "Couldn't save that. Please try again." });
  }
};

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
  setNoTarget,
  askAria,
  chat,
  resolveNoJdContext,
  // Exported so Aria Studio can build+cache a Role Brief on a freshly-cloned draft
  // without duplicating the JD-hash cache logic. Not route handlers.
  resolveDraftBrief,
  buildBriefForJd,
  briefHashFor,
  // Pure + request-free, so the "covered while building" rule can be unit-tested
  // against the scorer's own matcher without going through the chat route.
  openMustHavesFromDraft,
  targetRequirementsForEntry,
  // The cross-history hunt — pure, so the ladder's rules can be unit-tested without a turn.
  declinedRequirementKeys,
  huntContextsForDraft,
  buildHuntProbe,
  huntOffersForEntry,
  verifyProbeResult,
  selectRequiredRequirementProbe,
  verifiedInterviewEvidence,
  verifiedRequirementChecks,
};
