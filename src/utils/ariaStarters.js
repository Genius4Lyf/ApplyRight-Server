// MAKING THE ANSWER STARTERS ACTUALLY APPEAR.
//
// On every build-with turn the model returns `suggestions` — 2-3 short first-person
// openings with a literal "___" where the user's own detail goes. They are the most useful
// thing the turn produces for someone staring at an empty box.
//
// They were invisible most of the time. The prompt asked for them only as a JSON FIELD and
// never asked for them in the prose; the client dropped the field on the assumption that
// "Aria already writes those as bullets in her reply" — an assumption nothing enforced. So
// they appeared only on the turns where the model happened to volunteer them, which is
// exactly what users reported.
//
// The prompt now requires them in `reply`, and this is the safety net for when the model
// forgets: appended as ordinary markdown bullets, so they are part of Aria's message rather
// than a second help panel, and so the per-bullet copy control already in the chat picks
// them up for free.

/**
 * Does this markdown already contain a list item?
 *
 * The duplication guard. Deliberately coarse: if Aria bulleted ANYTHING, assume she made
 * her own offer and leave her alone. Appending a second list under one she already wrote
 * is worse than not appending at all — it reads as a stutter, and the whole complaint this
 * fixes was about seeing the same thing twice.
 *
 * @param {string} markdown
 * @returns {boolean}
 */
function hasListItem(markdown) {
  return String(markdown || "")
    .split("\n")
    .some((line) => /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)\S/.test(line));
}

/**
 * Append the starters to a reply that does not already offer any.
 *
 * @param {string} reply the model's markdown reply
 * @param {string[]} suggestions
 * @param {string} [label] the model's own lead-in, e.g. "Ways to show the impact:"
 * @returns {string}
 */
function appendStarters(reply, suggestions, label = "") {
  const body = String(reply || "").trim();
  const items = (Array.isArray(suggestions) ? suggestions : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  if (!items.length) return body;
  if (hasListItem(body)) return body;

  const lead = String(label || "").trim() || "Here are some ways to start your answer:";
  // Quoted, because these are words to SAY, not instructions to follow — unquoted they read
  // as Aria telling the user what they did.
  const bullets = items.map((s) => `- "${s.replace(/^["']|["']$/g, "")}"`).join("\n");

  return `${body}\n\n${lead}\n\n${bullets}`;
}

module.exports = { hasListItem, appendStarters };
