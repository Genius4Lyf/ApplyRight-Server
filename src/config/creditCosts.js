// Single source of truth for per-action credit costs.
//
// These are the REAL, currently-charged values (previously hardcoded and
// scattered across analysis/ai/interviewPrep/resume/billing controllers). The
// admin panel can override any of them via SystemSettings.creditCosts, but that
// override map starts EMPTY — so with no admin edits, settings.getCreditCosts()
// returns exactly these numbers and every action charges what it always has.
//
// Keys are the canonical backend names. The frontend mirror (lib/credits.js)
// uses FIT_ANALYSIS for what is ANALYSIS here; that one rename is handled in the
// frontend hydrate step, NOT by aliasing here (aliases risk silent divergence).
const DEFAULT_CREDIT_COSTS = Object.freeze({
  ANALYSIS: 10,
  GENERATE_CV: 10,
  GENERATE_COVER_LETTER: 5,
  GENERATE_INTERVIEW: 10,
  GENERATE_INTERVIEW_MORE: 5,
  GENERATE_STORIES: 5,
  GENERATE_ESSENTIAL: 2,
  GENERATE_DRESS_GUIDE: 2,
  GENERATE_BUNDLE: 18,
  CREATE_FROM_UPLOAD: 15,
  GENERATE_SKILLS: 10,
  GENERATE_JD_KEYWORDS: 5,
  GRADE_ANSWER: 1,
  GRADE_STORY: 1,
  FOLLOWUP: 1,
  // Rewrite a professional summary into a tighter, shorter version.
  TIGHTEN_SUMMARY: 1,
  // Defined for the planned premium gate but NOT enforced today — Interview Mode
  // is free during testing. Kept here so the key is admin-visible/adjustable.
  INTERVIEW_MODE: 5,
  // Uniform premium CV-template unlock price (paid tiers unlock all for free).
  TEMPLATE_UNLOCK: 30,
});

// Return a shallow copy of the defaults (never hand out the frozen original for
// callers that might merge onto it).
const getDefaults = () => ({ ...DEFAULT_CREDIT_COSTS });

module.exports = { DEFAULT_CREDIT_COSTS, getDefaults };
