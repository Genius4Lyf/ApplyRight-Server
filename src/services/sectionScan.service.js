/**
 * Section scan — per-section red/amber/green verdicts for Aria Studio.
 *
 * DETERMINISTIC and pure: no AI, no I/O, no clock. Every number here comes from
 * rules that already exist elsewhere in the codebase, combined rather than
 * reinvented:
 *
 *   QUALITY   — atsCoach.computeATSReadiness's per-check points, subtotalled by the
 *               `section` tag each check carries, over the canonical SECTION_POINTS
 *               budget. JD-blind: "is this section well built?"
 *   RELEVANCE — skillNormalizer.computeKeywordCoverage of the job's keywords against
 *               THAT SECTION'S text only — and only the keywords that section could
 *               ever satisfy (see CLASSIFICATION_RULES). JD-aware: "does this section
 *               speak to the job?"
 *
 * The split matters: a beautifully written summary for the wrong job scores high
 * quality and low relevance, and the user needs to see which of the two is broken.
 */

const { computeATSReadiness, SECTION_POINTS } = require("./atsCoach.service");
const { computeKeywordCoverage } = require("./skillNormalizer.service");
const { dismissedSectionsOf } = require("../config/sections");

/**
 * Version of the scoring RULES in this file — the classification table, the section
 * weights, the credential matcher. Stamped into the persisted studioScan snapshot so a
 * scan saved under older rules can be told apart from a fresh one (a section verdict is
 * only comparable to another computed the same way). Bump on every rules change.
 */
const SCAN_RULES_VERSION = 3;

/**
 * Score → band. Mirrors the frontend's bandOf (src/lib/applicationInsights.js) so a
 * section dot here and a fit-score accent there never disagree. Single source of
 * truth on this side of the wire; exported so tests and callers use the same numbers.
 */
const BAND_THRESHOLDS = { ok: 75, warn: 45 };

const bandOf = (score) => {
  if (score == null) return "neutral";
  if (score >= BAND_THRESHOLDS.ok) return "ok";
  if (score >= BAND_THRESHOLDS.warn) return "warn";
  return "bad";
};

// How much the JD-relevance half counts.
//
// CONTACT is scored on quality alone: a job description cannot keyword-match a phone
// number, and no classification rule below routes a keyword to it, so its keyword list
// is always empty anyway — the 0 is belt-and-braces.
//
// EDUCATION does measure relevance, but at a quarter weight. It only ever sees
// credential/certification keywords (a degree, a licence — the things a school record
// can actually answer), and it is mostly a completeness fact: one unmatched credential
// should pull the band down without flipping an otherwise complete section to red.
// With no such keyword in the job, its list is empty and it falls back to quality alone,
// exactly as it did when this weight was 0.
const RELEVANCE_WEIGHT = {
  summary: 0.5,
  experience: 0.5,
  skills: 0.5,
  projects: 0.5,
  education: 0.25,
  contact: 0,
};

const SECTIONS = [
  { key: "summary", label: "Summary" },
  { key: "experience", label: "Work history" },
  { key: "skills", label: "Skills" },
  { key: "education", label: "Education" },
  { key: "projects", label: "Projects" },
  { key: "contact", label: "Contact details" },
];

// The text of ONE section — what relevance is measured against. Deliberately narrow:
// matching a keyword anywhere in the CV would make every section look equally relevant.
const sectionText = (draft, key) => {
  switch (key) {
    case "summary":
      return draft.professionalSummary || "";
    case "experience":
      return (draft.experience || [])
        .map((e) => [e.title, e.company, e.description].filter(Boolean).join(" "))
        .join("\n");
    case "skills":
      return (draft.skills || [])
        .map((s) => (typeof s === "string" ? s : s?.name))
        .filter(Boolean)
        .join(", ");
    case "education":
      // Certifications count as education TEXT even though they're a separate array on
      // the draft. Credential and certification keywords are routed to this section
      // (see CLASSIFICATION_RULES); if "PMP" or "NYSC certificate" could never appear in
      // the text we measure, routing it here would guarantee a permanent false miss.
      return [
        ...(draft.education || []).map((e) =>
          [e.degree, e.field, e.school, e.description].filter(Boolean).join(" ")
        ),
        ...(draft.certifications || []).map((c) => [c?.name, c?.issuer].filter(Boolean).join(" ")),
      ]
        .filter(Boolean)
        .join("\n");
    case "projects":
      return (draft.projects || [])
        .map((p) => [p.title, p.description].filter(Boolean).join(" "))
        .join("\n");
    case "contact":
      return Object.values(draft.personalInfo || {})
        .filter(Boolean)
        .join(" ");
    default:
      return "";
  }
};

// The job's keywords, preferring the Role Brief (richer, already confirmed by the user
// in the Studio) and falling back to the cached aiKeywords extraction.
const keywordsFrom = (jobData = {}) => {
  const brief = jobData.brief;
  if (brief && (brief.mustHaves?.length || brief.niceToHaves?.length)) {
    return [
      ...(brief.mustHaves || []).map((k) => ({
        name: typeof k === "string" ? k : k?.name,
        importance: "must_have",
      })),
      ...(brief.niceToHaves || []).map((k) => ({
        name: typeof k === "string" ? k : k?.name,
        importance: "nice_to_have",
      })),
    ].filter((k) => k.name);
  }
  return (jobData.aiKeywords || [])
    .map((k) => ({
      name: typeof k === "string" ? k : k?.name,
      importance: k?.importance || "nice_to_have",
    }))
    .filter((k) => k.name);
};

// ─── Keyword scoping ────────────────────────────────────────────────────────────────
//
// Not every keyword can be answered by every section. "NYSC certificate" is a school
// record; the Projects section has no way to satisfy it and no way to fix it. Scoring
// one job-wide list against all six sections meant a credential appeared as missing from
// Summary, Work history, Skills AND Projects at once — clicking "Fix" on Projects told
// the user their school certificate was missing. Each keyword is therefore routed to the
// sections that could actually carry it, and a section only ever sees its own list.

// Where a keyword goes when nothing more specific matches: the four content sections
// where a skill, tool or domain term can legitimately be evidenced.
const DEFAULT_SECTIONS = ["skills", "experience", "projects", "summary"];

// Degrees, exam bodies and national schemes — things only a school record proves.
// Word-boundary anchored so "BA" never fires inside "database" and "OND" never inside
// "bond". Dots are optional so "B.Sc", "BSc" and "B. Sc" are the same rule.
const CREDENTIAL_PATTERNS = [
  /\bb\.?\s?sc\b/i,
  /\bbsc\b/i,
  /\bb\.?\s?a\b/i,
  /\bm\.?\s?sc\b/i,
  /\bmsc\b/i,
  /\bmba\b/i,
  /\bph\.?\s?d\b/i,
  /\bhnd\b/i,
  /\bond\b/i,
  /\bbachelor'?s?\b/i,
  /\bmaster'?s?\b/i,
  /\bdoctorate\b/i,
  /\bdegrees?\b/i,
  /\bdiplomas?\b/i,
  /\bwaec\b/i,
  /\bneco\b/i,
  /\bjamb\b/i,
  /\bnysc\b/i,
  /\bssce\b/i,
  /\ba-levels?\b/i,
  /\bgcse\b/i,
  /\bgraduate of\b/i,
];

// Professional certifications and licences. Routed to BOTH education and skills ON
// PURPOSE: people list "PMP" or "AWS Certified" in either place, and a certificate typed
// into Skills is the same fact as one typed into Education — so evidence found in either
// counts for both (see POOLED_KINDS below).
const CERTIFICATION_PATTERNS = [
  /\bcertified\b/i,
  /\bcertifications?\b/i,
  /\blicen[cs]e[ds]?\b/i, // license / licence / licensed / licences
  /\bacca\b/i,
  /\bican\b/i,
  /\bcpa\b/i,
  /\bcfa\b/i,
  /\bpmp\b/i,
  /\bcisa\b/i,
  /\bcissp\b/i,
  /\bcomptia\b/i,
  /\bprince2\b/i,
  /\bsix sigma\b/i,
];

// "5+ years", "3 yrs" — a claim about a career's length, provable by the work history
// or asserted in the summary. Nothing else can carry it.
const TENURE_PATTERN = /\b\d+\+?\s*(years?|yrs?)\b/i;

// Deliberately an EXPLICIT list rather than a regex: soft skills are a small, closed,
// human-curated set, and a loose pattern here would swallow half the default bucket.
// Matched as a whole phrase inside the keyword, so "Strong communication skills" and
// "problem-solving" both land here.
const SOFT_TERMS = [
  "communication",
  "teamwork",
  "leadership",
  "attention to detail",
  "problem solving",
  "interpersonal",
  "time management",
  "work ethic",
  "self motivated", // "self-motivated" normalizes to this
];

// Punctuation → spaces, so hyphens/slashes in a keyword don't hide a phrase match.
const flatten = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const containsPhrase = (flat, phrase) =>
  new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(flat);

// ORDERED. First match wins — read this top to bottom, it is the whole contract.
const CLASSIFICATION_RULES = [
  {
    kind: "credential",
    sections: ["education"],
    test: (lower) => CREDENTIAL_PATTERNS.some((re) => re.test(lower)),
  },
  {
    kind: "certification",
    sections: ["education", "skills"],
    test: (lower) => CERTIFICATION_PATTERNS.some((re) => re.test(lower)),
  },
  {
    kind: "tenure",
    sections: ["experience", "summary"],
    test: (lower) => TENURE_PATTERN.test(lower),
  },
  {
    kind: "soft",
    sections: ["summary", "experience", "skills"],
    test: (lower) => {
      const flat = flatten(lower);
      return SOFT_TERMS.some((term) => containsPhrase(flat, term));
    },
  },
];

/**
 * Which KIND of requirement is this, and which sections can satisfy it?
 *
 * The fallback is never empty. If a future rule wants to scope a keyword to nothing,
 * the right behaviour is to drop it from every section — NOT to fall back to "show it
 * everywhere", which is precisely the bug this table exists to kill.
 *
 * @param {string|{name:string}} name
 * @returns {{ kind: string, sections: string[] }} sections is a fresh array (callers
 *          must not be able to mutate the rule table)
 */
const classifyKeyword = (name) => {
  const raw = typeof name === "string" ? name : name?.name || "";
  const lower = raw
    .toLowerCase()
    .replace(/[’‘´`]/g, "'")
    .trim();
  if (!lower) return { kind: "general", sections: [...DEFAULT_SECTIONS] };

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test(lower)) return { kind: rule.kind, sections: [...rule.sections] };
  }
  return { kind: "general", sections: [...DEFAULT_SECTIONS] };
};

/**
 * Tag a job's keyword list with its kind and its scope. Pure.
 *
 * @param {Array<string|{name:string, importance?:string}>} keywords
 * @returns {Array<{ name: string, importance: string, kind: string, sections: string[] }>}
 */
const scopeKeywords = (keywords = []) =>
  (keywords || [])
    .map((kw) => {
      const name = (typeof kw === "string" ? kw : kw?.name || "").trim();
      if (!name) return null;
      const { kind, sections } = classifyKeyword(name);
      return {
        name,
        importance: (typeof kw === "string" ? null : kw?.importance) || "nice_to_have",
        kind,
        sections,
      };
    })
    .filter(Boolean);

/**
 * The keywords ONE section is answerable for. Anything scoped to no sections at all
 * simply never appears — dropped, not spread everywhere.
 *
 * @param {ReturnType<typeof scopeKeywords>} scoped
 * @param {string} key section key
 * @returns {Array<{ name: string, importance: string, kind: string }>}
 */
const keywordsForSection = (scoped = [], key) =>
  (scoped || [])
    .filter((k) => Array.isArray(k?.sections) && k.sections.includes(key))
    .map(({ name, importance, kind }) => ({ name, importance, kind }));

// ─── Credential matching ────────────────────────────────────────────────────────────
//
// computeKeywordCoverage matches whole tokens (skillNormalizer.textMentions), so
// "B.Sc in Accounting" can essentially never match the free prose "BSc Accounting,
// University of Lagos" and would sit in missingKeywords forever. This matcher is LOCAL
// to this file on purpose: textMentions is shared with the CV builder's live keyword
// tracker and the scoring engine, and loosening it there would manufacture false
// "covered" results across the whole product.

// Wrapper nouns that carry no evidence of their own — the specific credential token is
// what proves the claim, so requiring these as well would only create false misses.
const CREDENTIAL_STOPWORDS = new Set([
  "in",
  "of",
  "a",
  "an",
  "the",
  "and",
  "or",
  "with",
  "degree",
  "degrees",
  "qualification",
  "qualifications",
  "certificate",
  "certificates",
  "holder",
  "minimum",
]);

// Multi-word spellings folded to one token BEFORE stopwords are dropped (they contain
// stopwords themselves). Longest first so "master of business administration" is not
// eaten by "master of ...".
const CREDENTIAL_PHRASE_FOLDS = [
  ["master of business administration", "~mba"],
  ["national youth service corps", "~nysc"],
  ["ordinary national diploma", "~ond"],
  ["higher national diploma", "~hnd"],
  ["bachelor of engineering", "~bachelor"],
  ["bachelor of technology", "~bachelor"],
  ["bachelor of science", "~bachelor"],
  ["bachelor of arts", "~bachelor"],
  ["doctor of philosophy", "~doctorate"],
  ["master of science", "~master"],
  ["master of arts", "~master"],
].sort((a, b) => b[0].length - a[0].length);

// Single-token spellings of the same credential. Applied to BOTH sides of the
// comparison, so "B.Sc" in the job and "BSc" on the CV become the same token.
// Deliberately excludes the ambiguous bare "bs"/"ms" (a CV saying "MS Excel" must never
// be read as a master's degree).
const CREDENTIAL_TOKEN_FOLDS = {
  bsc: "~bachelor",
  ba: "~bachelor",
  beng: "~bachelor",
  btech: "~bachelor",
  bachelor: "~bachelor",
  bachelors: "~bachelor",
  msc: "~master",
  ma: "~master",
  meng: "~master",
  master: "~master",
  masters: "~master",
  mba: "~mba",
  phd: "~doctorate",
  doctorate: "~doctorate",
  doctoral: "~doctorate",
  hnd: "~hnd",
  ond: "~ond",
  nysc: "~nysc",
};

// "B.Sc in Accounting" → ["~bachelor", "accounting"]. Dots and apostrophes are removed
// FIRST so "B.Sc" collapses to one token and "bachelor's" to "bachelors".
const foldCredentialTokens = (value) => {
  let flat = String(value || "")
    .toLowerCase()
    .replace(/[.'’‘´`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!flat) return [];

  for (const [phrase, canonical] of CREDENTIAL_PHRASE_FOLDS) {
    if (flat.includes(phrase)) flat = flat.split(phrase).join(canonical);
  }

  return [
    ...new Set(
      flat
        .split(/\s+/)
        .map((tok) => CREDENTIAL_TOKEN_FOLDS[tok] || tok)
        .filter((tok) => tok && !CREDENTIAL_STOPWORDS.has(tok))
    ),
  ];
};

/**
 * Is this credential/certification evidenced anywhere in `lowerText`?
 *
 * Every significant token of the requirement must be present — order and wording are
 * free, but nothing is invented. A requirement that reduces to no significant tokens
 * (e.g. the bare word "degree") returns false rather than a vacuous true.
 *
 * @param {string} name       the keyword, as the job wrote it
 * @param {string} lowerText  the text to look in
 * @returns {boolean}
 */
const credentialCovered = (name, lowerText) => {
  const want = foldCredentialTokens(name);
  if (!want.length) return false;
  const have = new Set(foldCredentialTokens(lowerText));
  if (!have.size) return false;
  return want.every((tok) => have.has(tok));
};

// Kinds whose evidence is POOLED across their own scoped sections. A certificate typed
// into Skills and one typed into Education are the same fact about the same person, so
// finding it in either place covers it in both. Everything else is measured strictly
// against the section's own text — otherwise "Python" in Skills would flatter the
// Summary, which is the whole thing this file exists to prevent.
const POOLED_KINDS = new Set(["credential", "certification"]);

// WHICH honest thing to say about what's actually wrong — quality vs relevance are
// different problems with different fixes, so the note names which one it is.
//
// Returns a KEY and its params, never a sentence. The client renders it from
// `ariaStudio.sectionNote.<noteKey>` in the user's own language: a server that emits
// English prose hands a French user a fully French card whose headline verdict is
// English, and no amount of client-side translation can rescue a finished sentence.
//
// The three completeness branches deliberately carry NO label. The section name is
// already rendered immediately above the note, so it was redundant — and a generic
// "{{label}} is complete" is untranslatable into French, where the adjective must agree
// with the noun's gender ("Le résumé est complet" vs "L'expérience professionnelle est
// complète"). The strings these keys point at are label-free and gender-invariant.
const noteFor = ({ quality, relevance, weight, missingKeywords, hasKeywords }) => {
  const qualityBad = quality < BAND_THRESHOLDS.warn;
  const qualityMid = quality < BAND_THRESHOLDS.ok;
  const keywords = missingKeywords.slice(0, 3).join(", ");

  // No relevance was measured — either the section is JD-blind by weight (contact), or
  // this job asked nothing this section could answer. Either way the only honest thing
  // to talk about is completeness.
  if (weight === 0 || !hasKeywords) {
    if (quality >= BAND_THRESHOLDS.ok) return { noteKey: "complete" };
    if (qualityBad) return { noteKey: "missing" };
    return { noteKey: "incomplete" };
  }

  // Order matters: never call a section "well built" unless its QUALITY actually
  // clears the ok bar. A half-finished section that happens to miss keywords is a
  // quality problem first, and saying otherwise sends the user to fix the wrong thing.
  if (qualityBad && hasKeywords && missingKeywords.length) {
    return { noteKey: "thinAndMissing", noteParams: { keywords } };
  }
  if (qualityBad) return { noteKey: "tooThin" };
  if (qualityMid && hasKeywords && missingKeywords.length) {
    return { noteKey: "needsSubstance", noteParams: { keywords } };
  }
  if (qualityMid) return { noteKey: "solidStart" };
  if (hasKeywords && missingKeywords.length && relevance < BAND_THRESHOLDS.warn) {
    return { noteKey: "wellBuiltButMissing", noteParams: { keywords } };
  }
  if (hasKeywords && missingKeywords.length) {
    return { noteKey: "closeStillMissing", noteParams: { keywords } };
  }
  return { noteKey: "strong" };
};

/**
 * Score every CV section for quality (JD-blind) and relevance (JD-aware).
 *
 * @param {object} draft    a DraftCV (or plain object of the same shape)
 * @param {object} jobData  { brief?, aiKeywords? } — the job's extracted keywords
 * @returns {{ sections: Array<{ key, label, band, score, quality, relevance,
 *                               covered, total, missingKeywords, noteKey,
 *                               noteParams? }> }}
 */
const scanSections = (draft = {}, jobData = {}) => {
  const { checks } = computeATSReadiness(null, draft);
  // Sections the user marked not-applicable. A dismissed section is emitted as a
  // neutral row and never scored — it cannot be fixed, so a red verdict on it would
  // be advice to do the impossible. Whitelisted server-side (config/sections), so a
  // client cannot dismiss anything mandatory.
  const dismissed = dismissedSectionsOf(draft);
  // ONE classification pass for the whole job; each section then takes its own slice.
  const scoped = scopeKeywords(keywordsFrom(jobData));
  const skills = (draft.skills || [])
    .map((s) => (typeof s === "string" ? s : s?.name))
    .filter(Boolean);

  // Every section's text up front — pooled credential evidence has to look beyond the
  // section currently being scored.
  const texts = SECTIONS.reduce((acc, { key }) => {
    acc[key] = sectionText(draft, key);
    return acc;
  }, {});

  // Resolve pooled kinds once, against the union of their own scoped sections.
  const pooledCovered = new Map();
  scoped
    .filter((k) => POOLED_KINDS.has(k.kind) && k.sections.length)
    .forEach((k) => {
      const text = k.sections
        .map((s) => texts[s])
        .filter(Boolean)
        .join("\n");
      const base = computeKeywordCoverage([{ name: k.name, importance: k.importance }], {
        text,
        skills: k.sections.includes("skills") ? skills : [],
      });
      pooledCovered.set(
        k.name,
        !!base.results?.[0]?.covered || credentialCovered(k.name, text.toLowerCase())
      );
    });

  const sections = SECTIONS.map(({ key, label }) => {
    // ── Dismissed: the user said this section doesn't apply to them. Neutral, not
    //    'ok' — an absent section must never flatter the overall score, and a neutral
    //    band already renders as muted slate on the client (no new styling needed).
    //    bandOf(null) returns 'neutral'; the literal is written out to match the
    //    documented emit shape exactly.
    if (dismissed.has(key)) {
      return {
        key,
        label,
        dismissed: true,
        score: null,
        band: "neutral",
        quality: null,
        relevance: null,
        covered: 0,
        total: 0,
        missingKeywords: [],
        noteKey: "notApplicable",
        noteParams: undefined,
      };
    }

    // ── Quality: subtotal this section's earned points over its fixed budget ──
    const earned = checks
      .filter((c) => c.section === key)
      .reduce((sum, c) => sum + (c.points || 0), 0);
    const budget = SECTION_POINTS[key] || 0;
    const quality = budget ? Math.round((earned / budget) * 100) : 0;

    // ── Relevance: coverage of THIS SECTION'S keywords against THIS section's text ──
    const text = texts[key];
    const weight = RELEVANCE_WEIGHT[key] ?? 0.5;
    const sectionKeywords = keywordsForSection(scoped, key);
    // Load-bearing: a section the job asked nothing of has no relevance to measure, so
    // it falls back to quality alone rather than scoring 0 for keywords it could never
    // have carried.
    const measuresRelevance = weight > 0 && sectionKeywords.length > 0;

    let results = [];
    if (measuresRelevance) {
      const coverage = computeKeywordCoverage(sectionKeywords, {
        text,
        // Only the skills section gets the discrete skill-list matcher; elsewhere
        // it would credit a section for keywords that live somewhere else entirely.
        skills: key === "skills" ? skills : [],
      });
      const kindOf = new Map(sectionKeywords.map((k) => [k.name, k.kind]));
      results = (coverage.results || []).map((r) =>
        POOLED_KINDS.has(kindOf.get(r.name))
          ? { ...r, covered: r.covered || pooledCovered.get(r.name) === true }
          : r
      );
    }

    const total = results.length;
    const covered = results.filter((r) => r.covered).length;
    const relevance = total ? Math.round((covered / total) * 100) : 0;

    const missingKeywords = results
      .filter((r) => !r.covered)
      .sort(
        (a, b) => (b.importance === "must_have" ? 1 : 0) - (a.importance === "must_have" ? 1 : 0)
      )
      .map((r) => r.name);

    // ── Blend. With no keywords to measure against, relevance is unknown rather
    //    than zero — fall back to quality alone instead of halving every score.
    const score = measuresRelevance
      ? Math.round(quality * (1 - weight) + relevance * weight)
      : quality;

    return {
      key,
      // Still emitted because other code reads it, but the client no longer RENDERS it —
      // it resolves the section name from `ariaStudio.studioFlow.sections.<key>`, which
      // is the one source of truth for those six names and is already translated.
      label,
      band: bandOf(score),
      score,
      quality,
      relevance: measuresRelevance ? relevance : null,
      covered,
      total,
      missingKeywords,
      // A key + its params, never a sentence. See noteFor.
      ...noteFor({
        quality,
        relevance,
        weight,
        missingKeywords,
        hasKeywords: measuresRelevance,
      }),
    };
  });

  return { sections };
};

module.exports = {
  scanSections,
  bandOf,
  BAND_THRESHOLDS,
  RELEVANCE_WEIGHT,
  SECTIONS,
  SCAN_RULES_VERSION,
  classifyKeyword,
  scopeKeywords,
  keywordsForSection,
};
