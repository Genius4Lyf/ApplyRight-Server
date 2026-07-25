// Delivery telemetry — turning per-answer measurements from the live interview
// into the handful of numbers the debrief is allowed to talk about.
//
// The raw per-answer records are measured in the BROWSER (audio never reaches us
// — see realtime.service.js), but the arithmetic lives here, server-side, so it
// is unit-testable and can be corrected without shipping a client build.
//
// The contract with the assessor is strict: it may only comment on delivery where
// one of these numbers supports it. Anything not measured here is not sayable.

// Fillers are counted from the TRANSCRIPT rather than the audio — the client
// never sees this list, and it can be tuned without a frontend deploy.
// Multi-word entries are matched as phrases; single words on word boundaries.
const FILLERS = [
  "um",
  "uh",
  "erm",
  "er",
  "ah",
  "hmm",
  "like",
  "you know",
  "i mean",
  "sort of",
  "kind of",
  "basically",
  "actually",
];

// An answer this short cannot carry a real example — no situation, no action, no
// outcome. An answer this long has almost always stopped answering the question.
const SHORT_ANSWER_MS = 15000;
const LONG_ANSWER_MS = 120000;

const num = (v) => (Number.isFinite(v) ? v : null);

const median = (arr) => {
  const xs = arr.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
};

const mean = (arr) => {
  const xs = arr.filter((v) => Number.isFinite(v));
  if (!xs.length) return null;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
};

/**
 * Count filler words/phrases across everything the candidate said.
 * Returns null when there is too little speech for a rate to mean anything.
 */
const fillerStats = (candidateText) => {
  const text = String(candidateText || "").toLowerCase();
  const totalWords = text.trim().split(/\s+/).filter(Boolean).length;
  if (totalWords < 30) return null; // a rate off 12 words is noise, not a finding

  let count = 0;
  const byWord = {};
  FILLERS.forEach((f) => {
    // \b works for both single words and phrases here since fillers are
    // alphabetic; escape nothing because the list is fixed and word-only.
    const re = new RegExp(`\\b${f.replace(/\s+/g, "\\s+")}\\b`, "g");
    const hits = (text.match(re) || []).length;
    if (hits) {
      count += hits;
      byWord[f] = hits;
    }
  });

  return {
    totalWords,
    fillerCount: count,
    // Per 100 words — the unit people can actually picture.
    fillerPer100Words: Math.round((count / totalWords) * 1000) / 10,
    topFillers: Object.entries(byWord)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([word, n]) => ({ word, count: n })),
  };
};

/**
 * Summarise per-answer records into session aggregates.
 *
 * @param {Array<{timeToFirstWordMs,answerDurationMs,longestPauseMs,wordCount}>} answers
 * @param {string} candidateText everything the candidate said, for filler density
 * @returns {object|null} null when there is nothing measured — the caller MUST
 *   treat null as "no delivery commentary allowed", never as "delivery was fine".
 */
const summarizeDelivery = (answers, candidateText = "") => {
  const rows = (Array.isArray(answers) ? answers : [])
    .filter((a) => a && typeof a === "object")
    .map((a) => ({
      timeToFirstWordMs: num(Number(a.timeToFirstWordMs)),
      answerDurationMs: num(Number(a.answerDurationMs)),
      longestPauseMs: num(Number(a.longestPauseMs)),
      wordCount: num(Number(a.wordCount)),
    }))
    // An answer with no duration measured tells us nothing.
    .filter((a) => a.answerDurationMs != null && a.answerDurationMs >= 0);

  // No measured answers → no delivery data AT ALL, deliberately including filler
  // density even though it could be counted from the text alone. Two reasons:
  // the caller uses null as the switch that re-imposes the full delivery ban, and
  // without session telemetry we cannot tell a live interview from the turn-based
  // mode where answers are TYPED — counting "um" in typed text is meaningless.
  if (!rows.length) return null;
  const filler = fillerStats(candidateText);

  const ttfw = rows.map((r) => r.timeToFirstWordMs).filter((v) => v != null);
  const durations = rows.map((r) => r.answerDurationMs);
  const pauses = rows.map((r) => r.longestPauseMs).filter((v) => v != null);

  return {
    answerCount: rows.length,
    // Hesitation before starting to answer.
    medianTimeToFirstWordMs: median(ttfw),
    worstTimeToFirstWordMs: ttfw.length ? Math.max(...ttfw) : null,
    // How long answers ran.
    meanAnswerMs: mean(durations),
    shortestAnswerMs: Math.min(...durations),
    longestAnswerMs: Math.max(...durations),
    answersUnder15s: durations.filter((d) => d < SHORT_ANSWER_MS).length,
    answersOver2min: durations.filter((d) => d > LONG_ANSWER_MS).length,
    // Freezing mid-answer.
    longestPauseWithinAnswerMs: pauses.length ? Math.max(...pauses) : null,
    meanWordsPerAnswer: mean(rows.map((r) => r.wordCount)),
    filler,
  };
};

/** Render the aggregates as compact labelled lines for the assessor prompt. */
const formatDeliveryForPrompt = (d) => {
  if (!d) return "";
  const sec = (ms) => (ms == null ? null : `${Math.round(ms / 100) / 10}s`);
  const lines = [
    d.answerCount ? `answers measured: ${d.answerCount}` : null,
    d.medianTimeToFirstWordMs != null
      ? `pause before answering — median ${sec(d.medianTimeToFirstWordMs)}, longest ${sec(
          d.worstTimeToFirstWordMs
        )}`
      : null,
    d.meanAnswerMs != null
      ? `answer length — mean ${sec(d.meanAnswerMs)}, shortest ${sec(
          d.shortestAnswerMs
        )}, longest ${sec(d.longestAnswerMs)}`
      : null,
    d.answersUnder15s ? `answers under 15s: ${d.answersUnder15s}` : null,
    d.answersOver2min ? `answers over 2 min: ${d.answersOver2min}` : null,
    d.longestPauseWithinAnswerMs != null
      ? `longest silence in the middle of an answer: ${sec(d.longestPauseWithinAnswerMs)}`
      : null,
    d.meanWordsPerAnswer != null ? `mean words per answer: ${d.meanWordsPerAnswer}` : null,
    d.filler
      ? `filler words: ${d.filler.fillerCount} in ${d.filler.totalWords} words (${
          d.filler.fillerPer100Words
        } per 100)${
          d.filler.topFillers.length
            ? `, most used: ${d.filler.topFillers.map((f) => `"${f.word}" ×${f.count}`).join(", ")}`
            : ""
        }`
      : null,
  ].filter(Boolean);
  return lines.length ? lines.map((l) => `- ${l}`).join("\n") : "";
};

module.exports = {
  summarizeDelivery,
  formatDeliveryForPrompt,
  fillerStats,
  SHORT_ANSWER_MS,
  LONG_ANSWER_MS,
  FILLERS,
};
