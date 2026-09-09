// THE CV'S PRESENTATION, AS A STORED FACT.
//
// Everything the CV Studio's Design tab sets — typeface, margins, density, paper size,
// page colour. It used to live only in the browser's localStorage under
// `cvDesign:<id>`, which meant a CV literally looked different on the owner's phone than
// on their laptop, and lost its design entirely when a cache was cleared. Design is a
// property of the document, not of the machine it was last opened on.
//
// The allowed values are declared HERE rather than only in the Mongoose schema because
// `findByIdAndUpdate` does not run validators (see the note in cv.controller). The schema
// enums are documentation; this sanitiser is the enforcement.

const DESIGN_ENUMS = Object.freeze({
  margins: ["narrow", "normal", "wide"],
  density: ["compact", "normal", "relaxed"],
  paper: ["a4", "letter"],
});

// Free-text fields, each bounded. A font stack and a hex are both short strings, and an
// unbounded one here would be a place to park arbitrary data on someone's CV.
const DESIGN_STRINGS = Object.freeze({ font: 120, ground: 32 });

const DESIGN_KEYS = Object.freeze([...Object.keys(DESIGN_ENUMS), ...Object.keys(DESIGN_STRINGS)]);

/**
 * Keep only the keys the Design tab owns, and only values it could have produced.
 *
 * Returns `undefined` for anything unusable, which is meaningful: the field is
 * `default: undefined` on the model, and ABSENT means "never chosen". A materialised
 * object of defaults would outrank a real choice still sitting in the user's localStorage
 * the first time they open the CV on a new device.
 */
function sanitizeDesign(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;

  const out = {};
  for (const [key, allowed] of Object.entries(DESIGN_ENUMS)) {
    if (allowed.includes(input[key])) out[key] = input[key];
  }
  for (const [key, max] of Object.entries(DESIGN_STRINGS)) {
    if (typeof input[key] === "string" && input[key].length <= max) out[key] = input[key];
  }
  return Object.keys(out).length ? out : undefined;
}

module.exports = { DESIGN_ENUMS, DESIGN_STRINGS, DESIGN_KEYS, sanitizeDesign };
