const { textOverlap } = require("./textOverlap");

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

/**
 * Drop sample answers that are really the user's own answer, tidied up.
 *
 * Reported: the user described diagnosing faults with a multimeter and continuity tester,
 * replacing the faulty part and re-testing — and the panel underneath then offered, as a
 * sample of what a strong answer sounds like: "I diagnosed faults with a multimeter and
 * continuity tester, traced a broken element or switch, replaced the faulty part, and
 * re-tested the appliance before returning it to the owner."
 *
 * Their own answer, handed back as an example of how to answer. It teaches nothing, and it
 * quietly puts a polished version of their words in front of them to agree with.
 *
 * This is the cost of moving samples INTO the user's trade (they used to come from an
 * unrelated field, which was safe and useless). The prompt asks for a different situation;
 * this is the net, because a prompt is a request.
 *
 * THRESHOLD, measured on the reported case and four plausible same-trade alternatives:
 *   33%  the echo
 *    6%  same trade, new situation (wiring a board)
 *    4%  same trade, new situation (generators)
 *    2%  same trade, same tools, different task
 *    0%  same trade, new situation (training juniors)
 * 0.20 sits far above every legitimate sample and well below the echo.
 *
 * @param {string[]} exampleAnswers
 * @param {{who: string, text: string}[]} messages the turn window
 * @param {number} [threshold]
 * @returns {string[]}
 */
function dropEchoedSamples(exampleAnswers, messages, threshold = 0.2) {
  const samples = (Array.isArray(exampleAnswers) ? exampleAnswers : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!samples.length) return [];

  // The last few of THEIR turns. Older ones are not what a sample would be echoing, and
  // widening the net only costs real samples.
  const said = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.who === "user" && m.text)
    .slice(-3)
    .map((m) => String(m.text));
  if (!said.length) return samples;

  return samples.filter((sample) => !said.some((turn) => textOverlap(sample, turn) >= threshold));
}

/**
 * Drop answer starters that are the previous turn's starters again.
 *
 * Reported: asked "what tools did you use?", the starters were "I diagnosed faults using
 * ___" / "I repaired the ___ by replacing the ___". The user answered in full. The NEXT
 * question was "who did you mainly repair for?" — and the starters came back as "I
 * diagnosed faults using ___" / "I repaired appliances by replacing ___", which answer the
 * question before last.
 *
 * There is a direct cause, and it is our own doing: the starters are written INTO the
 * reply (see appendStarters — they were invisible otherwise), so they are sitting in the
 * transcript the model reads back on the next turn. Given its own bullets a few lines up,
 * it repeats them. The prompt now says not to; this is the net.
 *
 * THRESHOLD, measured on the reported case against three real answers to the new question:
 *   100%  identical starter, repeated
 *    67%  "I repaired appliances by replacing ___" vs "I repaired the ___ by replacing ___"
 *    67%  "I handled repairs for ___" vs "I handled appliance repairs for ___"
 *    33%  "I mainly repaired for ___" — a genuine answer to the new question
 *     0%  the other two genuine answers
 * 0.50 sits in the gap. Dropping ALL of them is an acceptable outcome: no starters is
 * better than three that answer the previous question.
 *
 * @param {string[]} suggestions
 * @param {{who: string, text: string}[]} messages the turn window
 * @param {number} [threshold]
 * @returns {string[]}
 */
function dropRepeatedStarters(suggestions, messages, threshold = 0.5) {
  const items = (Array.isArray(suggestions) ? suggestions : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!items.length) return [];

  const lastAria = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.who === "aria" && m.text)
    .slice(-1)[0];
  if (!lastAria) return items;

  // The starters as they were written into that reply: quoted list items. Anything else in
  // her prose is her question, and a starter is allowed to echo the question.
  const previous = String(lastAria.text)
    .split("\n")
    .map((line) => line.match(/^\s{0,3}[-*+]\s+"?(.+?)"?\s*$/))
    .filter(Boolean)
    .map((m) => m[1].trim());
  if (!previous.length) return items;

  return items.filter((item) => !previous.some((old) => textOverlap(item, old) >= threshold));
}

/**
 * Move sample answers that were left loose in the prose into the field they belong to.
 *
 * `stripExampleAnswers` handles the model writing the samples in BOTH places — it matches
 * them against the field and cuts the copies. It is helpless when the field comes back
 * EMPTY and the prose is the only copy, which is what a project interview produced:
 *
 *     A few starting points:
 *     - "I developed the ___ module that ___"
 *     - "I ran user testing sessions and ___"
 *
 *     "I created a searchable mobilisation checklist module used by crews to prepare
 *     jobs, reducing lookup time." "I led field validation sessions with new operators."
 *
 * Two finished first-person sentences, run together at the end of the message, with no
 * "a full answer sounds like" panel underneath because there was nothing to put in it.
 * Unlabelled, unfolded, and indistinguishable from Aria asserting the user did those
 * things — the precise failure the fold exists to prevent.
 *
 * Stripping them would be the easy fix and the wrong one: the user loses the samples
 * entirely. Promoting them puts them where they were always meant to go.
 *
 * DETECTION, kept deliberately narrow. A line qualifies only when it is quoted sentences
 * and NOTHING else — remove every "…" segment and no letters or digits may remain. That
 * spares the shapes Aria really writes: a quotation inside a sentence (`The job
 * description asks for "Maintaining accurate records" — did you…`) keeps its prose, and a
 * bulleted starter keeps its "- ". Only a bare, standalone quote block is taken.
 *
 * @param {string} reply the model's markdown reply
 * @param {string[]} exampleAnswers what it returned in the field (often empty here)
 * @returns {{reply: string, exampleAnswers: string[]}}
 */
function promoteInlineSamples(reply, exampleAnswers) {
  const body = String(reply || "");
  const existing = (Array.isArray(exampleAnswers) ? exampleAnswers : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!body.trim()) return { reply: body.trim(), exampleAnswers: existing };

  const QUOTED = /[“"]([^”"]{20,})[”"]/g;
  const found = [];
  const lines = body.split("\n").filter((line) => {
    const trimmed = line.trim();
    // A list item is a starter, whatever it contains. Those belong in the prose.
    if (!trimmed || /^[-*+]\s/.test(trimmed)) return true;

    const quotes = [...trimmed.matchAll(QUOTED)].map((m) => m[1].trim());
    if (!quotes.length) return true;
    // Anything left once the quotes are gone means this was a sentence ABOUT something,
    // not a bare sample.
    if (/[a-z0-9]/i.test(trimmed.replace(QUOTED, " "))) return true;

    found.push(...quotes);
    return false;
  });

  if (!found.length) return { reply: body.trim(), exampleAnswers: existing };

  // A heading that introduced them has nothing left to introduce.
  const isOrphanHeading = (line) => /^\s*(?:\*\*)?[^\n]{0,40}:(?:\*\*)?\s*$/.test(line);
  while (lines.length) {
    const tail = lines[lines.length - 1];
    if (!tail.trim() || isOrphanHeading(tail)) lines.pop();
    else break;
  }

  const out = lines.join("\n").trim();
  return {
    // Never hand back an empty message. If the samples were the whole reply there is
    // nothing to promote them out of, and a blank bubble is worse than a loose quote.
    reply: out || body.trim(),
    // The field wins when it has something: it is the model's considered answer, where
    // this is a rescue. Capped at the two the panel is designed for.
    exampleAnswers: (existing.length ? existing : found).slice(0, 2),
  };
}

module.exports = {
  hasListItem,
  appendStarters,
  stripExampleAnswers,
  dropEchoedSamples,
  dropRepeatedStarters,
  promoteInlineSamples,
};
