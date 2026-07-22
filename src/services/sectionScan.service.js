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
 *               THAT SECTION'S text only. JD-aware: "does this section speak to the job?"
 *
 * The split matters: a beautifully written summary for the wrong job scores high
 * quality and low relevance, and the user needs to see which of the two is broken.
 */

const { computeATSReadiness, SECTION_POINTS } = require("./atsCoach.service");
const { computeKeywordCoverage } = require("./skillNormalizer.service");

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

// How much the JD-relevance half counts. Contact details and (largely) education are
// facts a job description doesn't keyword-match — nobody's phone number is "more
// relevant" to a role — so they're scored on quality alone. Scoring them on coverage
// would punish a complete CV for something it cannot fix.
const RELEVANCE_WEIGHT = {
  summary: 0.5,
  experience: 0.5,
  skills: 0.5,
  projects: 0.5,
  education: 0,
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
      return (draft.education || [])
        .map((e) => [e.degree, e.field, e.school, e.description].filter(Boolean).join(" "))
        .join("\n");
    case "projects":
      return (draft.projects || [])
        .map((p) => [p.title, p.description].filter(Boolean).join(" "))
        .join("\n");
    case "contact":
      return Object.values(draft.personalInfo || {}).filter(Boolean).join(" ");
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

// A short, honest sentence about what's actually wrong — quality vs relevance are
// different problems with different fixes, so the note names which one it is.
const noteFor = ({ key, label, quality, relevance, weight, missingKeywords, hasKeywords }) => {
  const qualityBad = quality < BAND_THRESHOLDS.warn;
  const qualityMid = quality < BAND_THRESHOLDS.ok;
  const top = missingKeywords.slice(0, 3).join(", ");

  if (weight === 0) {
    if (quality >= BAND_THRESHOLDS.ok) return `${label} is complete.`;
    if (qualityBad) return `${label} is missing — add it.`;
    return `${label} is incomplete.`;
  }

  // Order matters: never call a section "well built" unless its QUALITY actually
  // clears the ok bar. A half-finished section that happens to miss keywords is a
  // quality problem first, and saying otherwise sends the user to fix the wrong thing.
  if (qualityBad && hasKeywords && missingKeywords.length) {
    return `Thin, and it's missing ${top}.`;
  }
  if (qualityBad) return `Too thin — this section needs real content.`;
  if (qualityMid && hasKeywords && missingKeywords.length) {
    return `Needs more substance, and it doesn't mention ${top}.`;
  }
  if (qualityMid) return `Solid start, but it could be stronger.`;
  if (hasKeywords && missingKeywords.length && relevance < BAND_THRESHOLDS.warn) {
    return `Well built, but it doesn't mention ${top}.`;
  }
  if (hasKeywords && missingKeywords.length) {
    return `Close — still missing ${top}.`;
  }
  return `Strong, and it speaks to this job.`;
};

/**
 * Score every CV section for quality (JD-blind) and relevance (JD-aware).
 *
 * @param {object} draft    a DraftCV (or plain object of the same shape)
 * @param {object} jobData  { brief?, aiKeywords? } — the job's extracted keywords
 * @returns {{ sections: Array<{ key, label, band, score, quality, relevance,
 *                               covered, total, missingKeywords, note }> }}
 */
const scanSections = (draft = {}, jobData = {}) => {
  const { checks } = computeATSReadiness(null, draft);
  const keywords = keywordsFrom(jobData);
  const skills = (draft.skills || [])
    .map((s) => (typeof s === "string" ? s : s?.name))
    .filter(Boolean);

  const sections = SECTIONS.map(({ key, label }) => {
    // ── Quality: subtotal this section's earned points over its fixed budget ──
    const earned = checks
      .filter((c) => c.section === key)
      .reduce((sum, c) => sum + (c.points || 0), 0);
    const budget = SECTION_POINTS[key] || 0;
    const quality = budget ? Math.round((earned / budget) * 100) : 0;

    // ── Relevance: keyword coverage against THIS section's text only ──
    const text = sectionText(draft, key);
    const weight = RELEVANCE_WEIGHT[key] ?? 0.5;
    const measuresRelevance = weight > 0 && keywords.length > 0;

    let coverage = { covered: 0, total: 0, results: [] };
    if (measuresRelevance) {
      coverage = computeKeywordCoverage(keywords, {
        text,
        // Only the skills section gets the discrete skill-list matcher; elsewhere
        // it would credit a section for keywords that live somewhere else entirely.
        skills: key === "skills" ? skills : [],
      });
    }
    const relevance = coverage.total
      ? Math.round((coverage.covered / coverage.total) * 100)
      : 0;

    const missingKeywords = (coverage.results || [])
      .filter((r) => !r.covered)
      .sort(
        (a, b) =>
          (b.importance === "must_have" ? 1 : 0) - (a.importance === "must_have" ? 1 : 0)
      )
      .map((r) => r.name);

    // ── Blend. With no keywords to measure against, relevance is unknown rather
    //    than zero — fall back to quality alone instead of halving every score.
    const score = measuresRelevance
      ? Math.round(quality * (1 - weight) + relevance * weight)
      : quality;

    return {
      key,
      label,
      band: bandOf(score),
      score,
      quality,
      relevance: measuresRelevance ? relevance : null,
      covered: coverage.covered,
      total: coverage.total,
      missingKeywords,
      note: noteFor({
        key,
        label,
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

module.exports = { scanSections, bandOf, BAND_THRESHOLDS, RELEVANCE_WEIGHT, SECTIONS };
