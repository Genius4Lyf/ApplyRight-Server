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

/**
 * Take the FULL SAMPLE ANSWERS back out of the reply, if the model wrote them in.
 *
 * The starters above belong in the prose — they are stubs with a "___" in them and they
 * cannot be mistaken for a claim. `exampleAnswers` are the opposite: two polished,
 * complete first-person sentences. The interface renders them folded away behind "a full
 * answer sounds like", and that fold is the entire safety mechanism — it is what stops
 * them reading as things Aria believes the user did.
 *
 * Reported from use: the reply carried an "Examples:" heading with both samples spelled
 * out, and the panel underneath then showed the same two again. The prompt was the cause —
 * it said to write the STARTERS into the reply and said nothing whatever about the
 * samples, so the model generalised. It says so explicitly now, and this is the net for
 * when that is not enough, which is the lesson of the starters above in reverse.
 *
 * Deliberately EXACT-match, line by line. A paraphrase is left alone: cutting text on a
 * fuzzy match risks taking Aria's real sentence with it, and a duplicated sample is a
 * blemish where a truncated reply is a broken turn.
 *
 * @param {string} reply the model's markdown reply
 * @param {string[]} exampleAnswers the samples, as returned in the field
 * @returns {string}
 */
function stripExampleAnswers(reply, exampleAnswers) {
  const body = String(reply || "");
  const samples = (Array.isArray(exampleAnswers) ? exampleAnswers : [])
    .map((s) => String(s || "").trim())
    // Short enough to collide with an ordinary sentence is short enough to leave alone.
    .filter((s) => s.length >= 20);
  if (!samples.length || !body.trim()) return body.trim();

  const norm = (s) =>
    s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
  const needles = samples.map(norm);

  let lines = body.split("\n").filter((line) => {
    const flat = norm(line);
    if (!flat) return true;
    return !needles.some((needle) => flat.includes(needle));
  });

  // A heading left pointing at nothing. "Examples:" with its examples removed is worse
  // than either — it tells the user something is there and then shows them nothing.
  const isOrphanHeading = (line) => /^\s*(?:\*\*)?[^\n]{0,40}:(?:\*\*)?\s*$/.test(line);
  while (lines.length) {
    const tail = lines[lines.length - 1];
    if (!tail.trim()) lines.pop();
    else if (isOrphanHeading(tail)) lines.pop();
    else break;
  }

  const out = lines.join("\n").trim();
  // Never hand back nothing. If the samples WERE the whole reply, the original is the
  // lesser evil — an empty bubble is a failed turn.
  return out || body.trim();
}

module.exports = { hasListItem, appendStarters, stripExampleAnswers };
