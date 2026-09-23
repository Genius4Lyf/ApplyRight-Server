// HOW MUCH OF THIS SENTENCE IS THAT SENTENCE — one answer, used everywhere.
//
// Three separate questions in this codebase turn out to be the same measurement:
//   · is this generated bullet a restatement of one the role already has?
//   · is this sample answer just the user's own answer, tidied?
//   · are these answer starters the ones from the previous turn again?
//
// They were going to get three implementations and three thresholds, which is precisely
// the mistake `skillNormalizer` already records having made with "is this requirement
// covered?" — three files answering it differently, two of them in the same response.
// One measure here, and each caller names its own threshold with the numbers it measured.
//
// Compared on CONTENT words, with the connective tissue thrown away first: without that,
// any two sentences about the same job look similar merely for being about a job.

const STOPWORDS = new Set(
  (
    "a an the and or of to in on for with by at as is was were be been being that this those " +
    "these it its their our my his her they them from into across during before after every " +
    "all any so than then when which who what how why not no ensuring supporting helping " +
    "enabling while per via each other more most such i we you did do does done had has have"
  ).split(" ")
);

/**
 * The content words of a string, lowercased, as a Set.
 *
 * Tokens of three characters or fewer go: they are almost all connective, and the ones
 * that are not ("SWI", "PPE") are too short to distinguish two sentences on their own.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
const contentTokens = (text) =>
  new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
  );

/**
 * Jaccard overlap of two token sets: shared / combined. 0 when either is empty.
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0–1
 */
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/**
 * Convenience: overlap of two raw strings.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} 0–1
 */
const textOverlap = (left, right) => overlap(contentTokens(left), contentTokens(right));

module.exports = { STOPWORDS, contentTokens, overlap, textOverlap };
