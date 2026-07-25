/**
 * The two-language model.
 *
 *   INTERFACE language  User.interfaceLang → req.lang (set by language.middleware)
 *                       What Aria SPEAKS: chat, coaching, guidance, interview prep.
 *
 *   DOCUMENT language   DraftCV.outputLang
 *                       What the CV is WRITTEN in: bullets, summary, skills,
 *                       cover letter, the generated/tailored CV, section labels.
 *
 * They are deliberately independent — an English-speaking user can build a
 * French CV and be coached in English while doing it.
 *
 * outputLang === null means "not set" (every CV that predates this feature).
 * Those fall back to the request language, which is exactly the P0 behaviour,
 * so existing CVs are unaffected and need no backfill.
 */
const SUPPORTED = ["en", "fr"];

const isSupported = (v) => SUPPORTED.includes(v);

/** Request (interface) language, defaulting to English. */
const reqLang = (req) => (isSupported(req?.lang) ? req.lang : "en");

/**
 * DOCUMENT language for an already-loaded draft.
 * @param {object|null} draft  a DraftCV doc (or anything with .outputLang)
 * @param {object} req
 */
const docLang = (draft, req) => (isSupported(draft?.outputLang) ? draft.outputLang : reqLang(req));

/**
 * DOCUMENT language by draft id, for callers that don't already hold the draft.
 * Reads a single field and never throws — an unreadable/absent draft falls back
 * to the request language rather than failing the AI action.
 * @param {string} draftId
 * @param {object} req
 */
const docLangById = async (draftId, req) => {
  if (!draftId || draftId === "new") return reqLang(req);
  try {
    const mongoose = require("mongoose");
    if (!mongoose.Types.ObjectId.isValid(draftId)) return reqLang(req);
    const draft = await require("../models/DraftCV")
      .findById(draftId)
      .select("outputLang userId")
      .lean();
    // Don't let one user's language setting be read via another's draft id.
    if (!draft || String(draft.userId) !== String(req?.user?.id || req?.user?._id)) {
      return reqLang(req);
    }
    return docLang(draft, req);
  } catch {
    return reqLang(req);
  }
};

/**
 * DOCUMENT language for a NEWLY created CV: inherit the creator's app language
 * so a French user's new CVs default to French output. Falls back to the request
 * language for older accounts with no interfaceLang stored.
 */
const newCvLang = (req) =>
  isSupported(req?.user?.interfaceLang) ? req.user.interfaceLang : reqLang(req);

module.exports = { SUPPORTED, isSupported, reqLang, docLang, docLangById, newCvLang };
