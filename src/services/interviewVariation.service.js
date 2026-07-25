// The variation engine — so running the same job three times gives three
// different interviews, not the same one three times.
//
// ⚠️ THE DISCIPLINE THIS FILE HAS TO KEEP: the model already generates every
// question live, led above all by the candidate's previous answer. That is what
// makes the room feel real, and nothing here may compete with it. Everything
// below is a LIGHT STEER on where a session STARTS and which areas it leans on.
// It is not a running order, and it must never say what to ask.
//
// It is also NOT an anti-repetition rule. "Tell me about yourself" is asked in
// every real interview on earth; a session that contorted to avoid it would be
// less realistic, not more. The goal is "never the same interview", not "never
// the same question".
//
// COST: no AI call. Everything is sampled from data already computed and cached
// elsewhere (fit analysis, panel seats, skills, JD keywords).

// How many past sessions we keep as a variation index. Enough to spread a pool
// across; small enough that the document cannot grow without bound.
const HISTORY_CAP = 10;

// How many areas to steer toward per session. Deliberately FEW — a long list
// becomes a syllabus, and leaves no room for follow-the-answer.
const SAMPLE_SIZE = 3;

const POOL_CAP = 24;

// Opener STRATEGIES — described as intent, never as sentences. Which one a
// session gets is the single biggest lever on whether two runs feel different,
// because the first ninety seconds set the shape of everything after them.
const OPENER_STRATEGIES = {
  self_intro: {
    key: "self_intro",
    // The classic. Kept in rotation deliberately: it is what real interviews do.
    intent:
      "Open the way most interviews open — invite them to introduce themselves and walk you through their background, then follow whatever they raise.",
  },
  cv_specific: {
    key: "cv_specific",
    intent:
      "Skip the general introduction. Open on ONE specific thing from their CV that is relevant here — a role, a project, something concrete — and ask them to take you into it. Let the rest of the interview grow from there.",
  },
  jd_requirement: {
    key: "jd_requirement",
    intent:
      "Open from the job's side rather than theirs: name something this role genuinely needs and ask them to show you where they have done it. Start with the requirement, not their history.",
  },
  gap_bridge: {
    key: "gap_bridge",
    intent:
      "Open on the distance between where they are and what this role asks for — not as a challenge, but as the honest first question: ask how they see themselves stepping into it. Neutral and curious, never sceptical.",
  },
};

const STRATEGY_ORDER = ["self_intro", "cv_specific", "jd_requirement", "gap_bridge"];

const clean = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim();

const norm = (s) => clean(s).toLowerCase();

/**
 * Build the competency pool for a role from ALREADY-CACHED data. A JD yields far
 * more than fits in six minutes, so we collect everything once and sample per
 * session.
 *
 * Sources, richest first: the JD's must-have skills, the panel seats' focus areas
 * (themselves JD-derived), the candidate's evidenced skills, and the cached AI
 * keyword extraction from the linked CV's target job.
 *
 * @returns {string[]} deduped competency labels
 */
const buildCompetencyPool = ({ application = {}, draft = null } = {}) => {
  const prep = application.interviewPrep || {};
  const fa = application.fitAnalysis || {};
  const out = [];
  const seen = new Set();

  const push = (name) => {
    const v = clean(name);
    if (!v || v.length > 80) return;
    const k = norm(v);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };

  // 1. What the JD says the role must have, and what the candidate is missing —
  //    the areas a real interviewer would actually probe.
  const skillNames = (arr, importance) =>
    (Array.isArray(arr) ? arr : [])
      .filter((s) => s && s.name && (!importance || s.importance === importance))
      .map((s) => s.name);
  skillNames(fa.missingSkills, "must_have").forEach(push);
  skillNames(fa.matchedSkills, "must_have").forEach(push);

  // 2. Panel seats' focus areas — already JD-derived and cached on the record.
  (Array.isArray(prep.panel?.seats) ? prep.panel.seats : []).forEach((s) => push(s?.focus));

  // 3. Skills the candidate has evidence for.
  (Array.isArray(prep.skillsWithEvidence) ? prep.skillsWithEvidence : []).forEach((s) =>
    push(s?.name)
  );

  // 4. Cached AI keyword extraction from the linked CV's target job.
  (Array.isArray(draft?.targetJob?.aiKeywords) ? draft.targetJob.aiKeywords : [])
    .filter((k) => k && k.name)
    .sort((a, b) => (a.importance === "must_have" ? -1 : 0) - (b.importance === "must_have" ? -1 : 0))
    .forEach((k) => push(k.name));

  // 5. Nice-to-haves last — real filler when a role is thinly specified.
  skillNames(fa.missingSkills).forEach(push);
  skillNames(fa.matchedSkills).forEach(push);

  return out.slice(0, POOL_CAP);
};

/**
 * Pick this session's opener strategy, avoiding the previous one.
 * Rotates deterministically through the list rather than randomly, so a user
 * running back-to-back sessions gets a visibly different opening each time.
 */
const pickOpenerStrategy = (history = [], archetype = null) => {
  // ⚠️ The archetype constrains WHICH openers are legal, and rotation happens
  // inside that set — not the other way round. A Behavioural round opened on a
  // bare job requirement invites a hypothetical answer, which is the one thing
  // that archetype exists to avoid. Constraining the set beats letting an
  // incompatible opener be picked and then telling the model to work around it.
  const allowed =
    Array.isArray(archetype?.openers) && archetype.openers.length
      ? STRATEGY_ORDER.filter((k) => archetype.openers.includes(k))
      : STRATEGY_ORDER;
  const order = allowed.length ? allowed : STRATEGY_ORDER;

  const last = history.length ? history[history.length - 1]?.openerStrategy : null;
  const usedRecently = history
    .slice(-order.length + 1)
    .map((h) => h?.openerStrategy)
    .filter(Boolean);

  // First choice: something never used in the recent window.
  const fresh = order.find((k) => !usedRecently.includes(k));
  if (fresh) return OPENER_STRATEGIES[fresh];

  // Everything used recently → advance one step from last, so we still rotate.
  const idx = order.indexOf(last);
  const next = order[(idx + 1) % order.length];
  return OPENER_STRATEGIES[next];
};

/**
 * Sample the areas to lean on this session, preferring what earlier sessions did
 * not cover. When the pool is exhausted it CYCLES rather than returning nothing —
 * a repeated area paired with a different opener does not read as a repeat.
 */
const sampleCompetencies = (pool = [], history = [], size = SAMPLE_SIZE) => {
  const items = (Array.isArray(pool) ? pool : []).filter(Boolean);
  if (!items.length) return { sampled: [], recycled: false };

  const covered = new Set();
  (Array.isArray(history) ? history : []).forEach((h) =>
    (Array.isArray(h?.competencies) ? h.competencies : []).forEach((c) => covered.add(norm(c)))
  );

  const unseen = items.filter((c) => !covered.has(norm(c)));
  if (unseen.length >= size) return { sampled: unseen.slice(0, size), recycled: false };

  // Pool exhausted (or nearly): take what's left, then cycle back through the
  // oldest-covered items to fill. Offsetting by session count keeps consecutive
  // recycled sessions from landing on the same ones.
  const offset = (Array.isArray(history) ? history.length : 0) * size;
  const recycledPool = items.filter((c) => covered.has(norm(c)));
  const fill = [];
  for (let i = 0; fill.length < size - unseen.length && i < recycledPool.length; i += 1) {
    fill.push(recycledPool[(offset + i) % recycledPool.length]);
  }
  return {
    sampled: [...unseen, ...fill].slice(0, size),
    recycled: fill.length > 0,
  };
};

/**
 * The whole plan for one session. Server-side, at mint.
 *
 * @returns {{openerStrategy, openerIntent, sampledCompetencies, previouslyCovered, recycled, sessionNumber}}
 */
const planSession = ({ pool = [], history = [], archetype = null } = {}) => {
  const hist = Array.isArray(history) ? history : [];
  const opener = pickOpenerStrategy(hist, archetype);
  // The archetype defines the ARC; variation picks emphasis WITHIN it. Sampling
  // therefore draws against the arc rather than ignoring it: arc areas lead, and
  // the JD-derived pool supplies the specifics hung off them.
  const arc = Array.isArray(archetype?.arc) ? archetype.arc : [];
  const drawFrom = arc.length ? [...arc, ...(Array.isArray(pool) ? pool : [])] : pool;
  const { sampled, recycled } = sampleCompetencies(drawFrom, hist);

  // What earlier sessions already went at — so this one can come from a
  // different angle rather than repeating the same approach.
  const previouslyCovered = [];
  const seen = new Set();
  hist
    .slice(-3)
    .flatMap((h) => (Array.isArray(h?.competencies) ? h.competencies : []))
    .forEach((c) => {
      const k = norm(c);
      if (!k || seen.has(k)) return;
      seen.add(k);
      previouslyCovered.push(clean(c));
    });

  return {
    openerStrategy: opener.key,
    openerIntent: opener.intent,
    sampledCompetencies: sampled,
    previouslyCovered: previouslyCovered.slice(0, 8),
    recycled,
    sessionNumber: hist.length + 1,
  };
};

/**
 * Build the session-history entry saved after a completed interview. Gists, not
 * transcripts — this is a variation index, not an archive.
 *
 * delivery + overallScore are kept deliberately: they make cross-session progress
 * ("your hesitation dropped from 9s to 3s") possible later. Nothing reads them yet.
 */
const buildHistoryEntry = ({
  plan = {},
  startedAt = null,
  archetype = "",
  questionsAsked = [],
  delivery = null,
  overallScore = null,
} = {}) => ({
  startedAt: startedAt || new Date(),
  archetype: clean(archetype),
  openerStrategy: plan.openerStrategy || "",
  competencies: (Array.isArray(plan.sampledCompetencies) ? plan.sampledCompetencies : []).slice(
    0,
    8
  ),
  // Short gists so the index stays small: the opening clause of each question.
  questionGists: (Array.isArray(questionsAsked) ? questionsAsked : [])
    .map((q) => clean(q).slice(0, 120))
    .filter(Boolean)
    .slice(0, 12),
  delivery: delivery || null,
  overallScore: Number.isFinite(overallScore) ? overallScore : null,
});

/** Append an entry, keeping only the most recent HISTORY_CAP. */
const appendHistory = (existing, entry) =>
  [...(Array.isArray(existing) ? existing : []), entry].slice(-HISTORY_CAP);

module.exports = {
  buildCompetencyPool,
  planSession,
  pickOpenerStrategy,
  sampleCompetencies,
  buildHistoryEntry,
  appendHistory,
  OPENER_STRATEGIES,
  STRATEGY_ORDER,
  HISTORY_CAP,
  SAMPLE_SIZE,
};
