/**
 * Metric Capture Service
 *
 * Detects "vague" bullets in extracted candidate experience — bullets that use
 * action verbs but lack any concrete numbers (team size, percentages, scale).
 * Surfaces a small batch back to the user so they can supply numbers BEFORE
 * the CV is generated. The supplied metrics are then woven into enhanceCVContent
 * as user-authored facts, which is the difference between paraphrased bullets
 * and ones that read as concrete achievements.
 *
 * No AI calls — pure regex over already-extracted bullet text.
 */

// Action verbs that often introduce a vague achievement claim. Lower-case.
const TRIGGER_VERBS = [
  "led", "managed", "built", "developed", "improved", "optimized",
  "reduced", "increased", "delivered", "launched", "shipped", "created",
  "implemented", "drove", "grew", "scaled", "streamlined", "architected",
  "owned", "established", "designed", "spearheaded", "transformed",
  "automated", "rolled out", "rolled-out", "oversaw", "coordinated",
];

// If any of these patterns appear in the bullet, we treat it as already
// quantified and skip it. The set is permissive — we'd rather miss a vague
// bullet than ask about a quantified one.
const NUMBER_PATTERNS = [
  /\d+%/,                              // 40%
  /\$\s?\d+[\d,.]*\s?[kKmMbB]?/,       // $2M, $1.4B, $500
  /\d+[\d,.]*\s?[kKmMbB]\b/,           // 10K users, 1.5M
  /\b\d{2,}[+]?\b/,                    // 10, 100+, 5000 (2+ digits)
  /\b\d+\s*(users?|customers?|clients?|engineers?|developers?|people|teams?|services?|countries|regions?|hours?|days?|weeks?|months?|years?|requests?|queries|deployments?|releases?|members?|employees|reports?|tickets?|bugs?|features?|components?|apps?|sites?|repositories|repos|environments?|tps|qps|rps|rpm|mbps|gbps|gb|tb|kb)\b/i,
  /\b(?:from\s+\d+.*?\s+to\s+\d+|\d+\s*->\s*\d+|\d+\s*→\s*\d+)\b/i,  // 45 to 6, 320→80
];

const ESCAPE = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TRIGGER_REGEX = new RegExp(
  `\\b(${TRIGGER_VERBS.map(ESCAPE).join("|")})\\b`,
  "i"
);

const hasNumber = (text) => NUMBER_PATTERNS.some((re) => re.test(text));
const hasTrigger = (text) => TRIGGER_REGEX.test(text);

/**
 * Build a placeholder hint based on which trigger verb the bullet starts with.
 * Helps the user know what kind of number is expected without forcing structure.
 */
const placeholderForBullet = (text) => {
  const lower = text.toLowerCase();
  if (/\b(led|managed|oversaw|coordinated|spearheaded)\b/.test(lower)) {
    return "e.g., team of 8 engineers, scope of 5 services";
  }
  if (/\b(improved|optimized|reduced|streamlined|automated)\b/.test(lower)) {
    return "e.g., latency 320ms → 80ms, deploy time cut by 60%";
  }
  if (/\b(increased|grew|scaled|drove)\b/.test(lower)) {
    return "e.g., from 10K to 50K users, revenue +30%";
  }
  if (/\b(built|developed|designed|architected|created|implemented|delivered|launched|shipped)\b/.test(lower)) {
    return "e.g., used by 12K users, $2M ARR, 4-engineer team";
  }
  return "e.g., team size, % impact, $ value, user count";
};

/**
 * Detect vague bullets across ranked experiences.
 *
 * @param {Array} rankedExperiences - output of cvOptimizer.rankExperiences,
 *   each entry has { role, company, description: string[], relevanceScore, ... }
 * @param {object} options
 * @param {number} [options.maxBullets=4] - cap on how many we surface to the user
 * @param {number} [options.minLength=30] - skip very short bullets
 * @returns {Array<{ bulletId, roleIndex, bulletIndex, original, roleTitle, company, relevanceScore, placeholder }>}
 */
const detectVagueBullets = (rankedExperiences, options = {}) => {
  const maxBullets = options.maxBullets ?? 4;
  const minLength = options.minLength ?? 30;

  if (!Array.isArray(rankedExperiences) || rankedExperiences.length === 0) {
    return [];
  }

  // Iterate in the ranked order so the highest-relevance roles are considered first.
  const candidates = [];
  rankedExperiences.forEach((exp, roleIndex) => {
    const description = exp.description;
    const bullets = Array.isArray(description)
      ? description
      : typeof description === "string" && description.trim()
      ? description.split(/\n|;/).map((s) => s.trim()).filter(Boolean)
      : [];

    bullets.forEach((bullet, bulletIndex) => {
      const text = String(bullet || "").trim();
      if (text.length < minLength) return;
      if (!hasTrigger(text)) return;
      if (hasNumber(text)) return;

      candidates.push({
        bulletId: `role${roleIndex}_bullet${bulletIndex}`,
        roleIndex,
        bulletIndex,
        original: text,
        roleTitle: exp.role || exp.title || "Role",
        company: exp.company || "",
        relevanceScore: typeof exp.relevanceScore === "number" ? exp.relevanceScore : 0,
        placeholder: placeholderForBullet(text),
      });
    });
  });

  // Sort by role relevance (descending) so the most-relevant roles get the
  // user's attention if we have to truncate.
  candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return candidates.slice(0, maxBullets);
};

/**
 * Format provided metrics into a prompt section for enhanceCVContent.
 * Returns "" if no metrics were provided so the prompt is unchanged in the
 * common skip-all case.
 *
 * @param {Object<string, string>} providedMetrics - { bulletId: hintText }
 * @param {Array} rankedExperiences - same array passed to detectVagueBullets
 * @returns {string} formatted block (empty string if nothing to add)
 */
const formatProvidedMetricsForPrompt = (providedMetrics, rankedExperiences) => {
  if (!providedMetrics || typeof providedMetrics !== "object") return "";
  const entries = Object.entries(providedMetrics).filter(
    ([, hint]) => typeof hint === "string" && hint.trim().length > 0
  );
  if (entries.length === 0) return "";

  const lines = [];
  for (const [bulletId, hint] of entries) {
    const match = bulletId.match(/^role(\d+)_bullet(\d+)$/);
    if (!match) continue;
    const roleIndex = Number(match[1]);
    const bulletIndex = Number(match[2]);
    const role = rankedExperiences[roleIndex];
    if (!role) continue;
    const description = Array.isArray(role.description) ? role.description : [];
    const original = description[bulletIndex] || "";
    if (!original) continue;

    lines.push(
      `For ROLE_${roleIndex + 1} (${role.role || role.title || "Role"}), bullet "${original.replace(/"/g, "'")}":\n  ${hint.trim()}`
    );
  }

  if (lines.length === 0) return "";

  return [
    "═══ USER-PROVIDED METRICS (authoritative — weave in truthfully) ═══",
    "These are facts the candidate has personally confirmed. Incorporate them",
    "into the matching bullet exactly as stated. Do not invent additional metrics.",
    "",
    ...lines,
  ].join("\n");
};

module.exports = {
  detectVagueBullets,
  formatProvidedMetricsForPrompt,
  // exported for unit testing
  hasNumber,
  hasTrigger,
};
