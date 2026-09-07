// What the user is LOOKING AT while they type.
//
// Aria's chat payload used to describe the user's position with one word — a builder step
// id turned into a label like "work history", falling back to "your CV". That is enough to
// coach a section and useless for anything else: asked "can you explain the three options?"
// while the career-stage card was on screen, the only list of things in the prompt was the
// CV section list inside APP_PRIMER, so the model explained the sections. It answered the
// only question it could see.
//
// The client now names the card in front of the user and the choices on it. This file is
// the gate that stands between that claim and the system prompt.
//
// TREAT IT AS UNTRUSTED. It is our own frontend today, but it arrives over the wire as
// request body, it is free text, and it is concatenated into a SYSTEM prompt — the most
// privileged position in the call. So it is bounded rather than validated against a
// whitelist of known cards: a whitelist would have to be edited every time a card is added
// (and would silently stop working when someone forgot), whereas caps hold no matter what
// ships next. Length is the real defence — an instruction long enough to override the
// surrounding prompt cannot fit through here.
//
// Malformed input yields null, never a throw: a bad descriptor must degrade to the old
// behaviour, never break someone's conversation.

// Deliberately tight. `title` is a card heading and `body` its one-line explainer — both
// are UI copy that already has to fit on a phone, so anything longer is not our card.
const MAX_TITLE = 120;
const MAX_BODY = 240;
const MAX_OPTION = 80;
const MAX_OPTIONS = 8;
// Kebab/colon ids only ('career-stage', 'build:sections'), so an id can never itself carry
// prose into the prompt.
const ID_RE = /^[a-z][a-z0-9:-]{0,39}$/;

// Strip control characters (newlines included) and collapse runs of whitespace. Newlines
// matter most: the prompt is assembled line by line, and a descriptor able to emit blank
// lines could forge what looks like the start of a new instruction block.
const clean = (v, max) => {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return v
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
};

/**
 * Bound a client-supplied screen descriptor.
 *
 * @param {unknown} raw `{ id, title, body, options: [{ key, label }] }` off the request body
 * @returns {{id: string, title: string, body: string, options: string[]}|null}
 */
const sanitizeScreen = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : "";
  const title = clean(raw.title, MAX_TITLE);
  // A card with no id and no title is not a screen we can say anything true about.
  if (!id || !title) return null;
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((o) => clean(typeof o === "string" ? o : o?.label, MAX_OPTION))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
  return { id, title, body: clean(raw.body, MAX_BODY), options };
};

module.exports = { sanitizeScreen, cleanText: clean, MAX_TITLE, MAX_BODY, MAX_OPTION, MAX_OPTIONS };
