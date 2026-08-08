/**
 * Which CV sections a user is allowed to mark NOT APPLICABLE — and the only reader
 * that decides whether a stored key counts.
 *
 * A candidate with no side projects is not a candidate with a BROKEN CV. Projects is a
 * genuinely optional section, so leaving it permanently red (and holding 15 ATS points
 * hostage that can never be earned) tells the user their CV is wrong about something
 * they deliberately chose. Every OTHER section is mandatory: a CV with no work history,
 * no skills, no education, no summary or no way to contact the candidate IS incomplete,
 * and letting the client opt out of being told so would turn the score into a mood ring.
 *
 * THE WHITELIST IS ENFORCED HERE, ON READ — not on save. Filtering at the point of use
 * covers every path into the field at once (the narrow saveDraft patch, an old document
 * written before this list shrank, a hand-edited record) rather than trusting that every
 * writer remembered to sanitize. An unknown or disallowed key is silently ignored: it is
 * not an error the user could have caused or can fix, and rejecting the whole save would
 * punish them for a client bug.
 */

/**
 * The allowed keys. Adding one here is not enough on its own — see the guard in
 * atsCoach.computeATSReadiness, whose points budget must skip the same section.
 */
const DISMISSABLE_SECTIONS = ["projects"];

/**
 * The sections this draft has legitimately dismissed.
 *
 * @param {object} draft a DraftCV (or plain object of the same shape)
 * @returns {Set<string>} only keys that appear in DISMISSABLE_SECTIONS
 */
const dismissedSectionsOf = (draft = {}) => {
  const raw = draft?.dismissedSections;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((key) => DISMISSABLE_SECTIONS.includes(key)));
};

module.exports = { DISMISSABLE_SECTIONS, dismissedSectionsOf };
