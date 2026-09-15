// GETTING SOMETHING USABLE OUT OF A HALF-WRITTEN JSON OBJECT.
//
// When a model runs out of budget mid-object, what comes back is a JSON literal with no
// closing brace — and `JSON.parse` can do nothing with it. The controller used to treat
// that as "the model answered in prose instead of JSON" and hand the fragment to the user
// as Aria's message, so people read `{"reply":"That's an excellent example! ...` in the
// chat.
//
// But the fragment is not worthless: `reply` is the FIRST key the prompt asks for, so in
// practice it is complete even when everything after it was cut off. Pulling it out turns
// a broken turn into a slightly-short one.
//
// Written by hand rather than with a JSON-repair dependency because the job is narrow —
// one known key, one string value — and a repair library would also happily "fix"
// half-written evidence arrays into something that looks authoritative and is not.

/**
 * Does this string look like a JSON object rather than prose?
 *
 * The structural guard: anything that answers true must never be shown to a user as a
 * message, on any surface.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function looksLikeJsonObject(raw) {
  const s = String(raw || "").trim();
  if (!s.startsWith("{")) return false;
  // A brace alone is not enough — prose can open with one. Require a quoted key
  // immediately after, which is what a serialized object always has.
  return /^\{\s*"[A-Za-z_$][\w$]*"\s*:/.test(s);
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };

/**
 * Extract the `reply` string from a possibly-truncated JSON object.
 *
 * Returns "" when there is nothing recoverable — the caller should then fall back to its
 * ordinary "try again" copy rather than showing anything.
 *
 * @param {string} raw the raw model output
 * @param {string} [key] the field to recover
 * @returns {string}
 */
function salvageJsonReply(raw, key = "reply") {
  const s = String(raw || "");
  if (!looksLikeJsonObject(s)) return "";

  const marker = `"${key}"`;
  const at = s.indexOf(marker);
  if (at === -1) return "";

  let i = s.indexOf(":", at + marker.length);
  if (i === -1) return "";
  i += 1;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  // Only a string value is salvageable; anything else is not the field we want.
  if (s[i] !== '"') return "";
  i += 1;

  let out = "";
  while (i < s.length) {
    const ch = s[i];

    if (ch === "\\") {
      const next = s[i + 1];
      // Cut off mid-escape — stop here rather than emitting a stray backslash.
      if (next === undefined) break;
      if (next === "u") {
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break; // truncated mid-codepoint
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ESCAPES[next] ?? next;
      i += 2;
      continue;
    }

    // The value closed properly, so everything up to here is the real reply.
    if (ch === '"') return out.trim();

    out += ch;
    i += 1;
  }

  // Ran off the end of the buffer: the reply ITSELF was truncated. Still the best thing
  // available, and far better than the raw object — but the caller decides whether a
  // fragment this short is worth showing.
  return out.trim();
}

module.exports = { salvageJsonReply, looksLikeJsonObject };
