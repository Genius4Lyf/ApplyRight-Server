// The SHAPE of an answer, chosen by Aria.
//
// Most replies are prose and should stay prose. But some questions have an answer with an
// obvious structure, and flattening it into a paragraph is what makes Aria read like a
// wall of text no matter how well the markdown renders. Two of those are worth a designed
// card:
//
//   options — "can you explain the three options?" asked at a card with buttons on it.
//             One row per choice, each with a line on who it fits. This is the question
//             that started all of it.
//   compare — "should I put X or Y?" Two or three alternatives side by side.
//
// Anything else is prose, which is the default and always valid.
//
// This is the gate between what the model claimed and what gets rendered. It is stricter
// than it looks, for one reason: a card is a stronger claim than a sentence. Prose that is
// slightly off reads as advice; a labelled row that names a button the user cannot see
// reads as fact. So a layout that does not validate does not degrade — it is DROPPED, and
// the reply renders as ordinary prose. Never a half-built card.
const { cleanText } = require("./screenContext");

const LAYOUTS = ["options", "compare"];
// Two is the minimum that can be laid out side by side; past four the card stops being
// scannable and prose is genuinely better.
const MIN_BLOCKS = 2;
const MAX_BLOCKS = 4;
const MAX_LABEL = 60;
const MAX_DETAIL = 180;

// Compared loosely — the model may echo a label with different case or spacing, which is
// not a reason to throw the card away. Anything beyond that is a different string, and a
// different string means an option the user cannot see.
const norm = (s) => cleanText(s, MAX_LABEL).toLowerCase();

/**
 * Bound a model-chosen answer layout.
 *
 * @param {object} a
 * @param {unknown} a.layout  "options" | "compare" | anything else
 * @param {unknown} a.blocks  [{ label, detail }]
 * @param {string[]} [a.screenOptions] the options actually on screen, when there is a card
 * @returns {{layout: string, blocks: {label: string, detail: string}[]}|null}
 */
const sanitizeAnswerLayout = ({ layout, blocks, screenOptions = [] } = {}) => {
  if (!LAYOUTS.includes(layout)) return null;

  const rows = (Array.isArray(blocks) ? blocks : [])
    .map((b) => ({
      label: cleanText(b?.label, MAX_LABEL),
      detail: cleanText(b?.detail, MAX_DETAIL),
    }))
    .filter((b) => b.label && b.detail)
    .slice(0, MAX_BLOCKS);

  if (rows.length < MIN_BLOCKS) return null;

  // The guarantee that makes the options card trustworthy: every row it shows is a button
  // the user can actually see. Aria describing a fourth choice that does not exist is a
  // worse failure than not drawing the card at all, so one bad label drops the whole thing.
  if (layout === "options") {
    const onScreen = new Map(screenOptions.map((o) => [norm(o), cleanText(o, MAX_LABEL)]));
    if (!onScreen.size) return null;
    if (!rows.every((r) => onScreen.has(norm(r.label)))) return null;
    // Show the BUTTON's own wording, not the model's echo of it. The card sits inches
    // from the thing it describes, so "experienced" under a button reading "Experienced"
    // is a small, avoidable wrongness.
    return { layout, blocks: rows.map((r) => ({ ...r, label: onScreen.get(norm(r.label)) })) };
  }

  return { layout, blocks: rows };
};

module.exports = { sanitizeAnswerLayout, LAYOUTS, MIN_BLOCKS, MAX_BLOCKS };
