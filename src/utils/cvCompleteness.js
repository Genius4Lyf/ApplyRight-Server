// Is this CV finished?
//
// A PORT of the frontend's rule, and it has to stay one. The client answer lives in two
// files — lib/cvCompleteness.js (the five required sections) and lib/studioFlow.js
// (hasSubstance / withoutBlankEntries / finishableNow, which strips placeholder rows
// first) — and `finishableNow` is what all of Aria Studio uses: it decides whether the
// live preview's editor unlocks and whether a build session reads as done.
//
// This exists because the server has to gate the same thing the user is looking at.
// DraftCV.isComplete is no help: it is a stored flag the CV WIZARD sets on reaching its
// finalize step, and a Studio session never posts that step, so it is false for
// essentially every CV this would be asked about.
//
// Keep the two in step. If the rule moves on the client and not here, the Recents rail
// starts offering an action the endpoint refuses — or worse, refusing one it would allow.

// An entry counts as REAL once it carries anything a reader would see. A row that exists
// only because the Studio needed a _sortId to write into is a placeholder, not content.
//
// The `||` chain short-circuits on the first TRUTHY field and trims only that one, so an
// entry like { title: "   ", company: "Acme" } reads as blank. That is faithful to the
// client (studioFlow.js:118) and deliberately so — a server that disagreed with the
// browser in even one corner would put the rail at odds with the chat beside it. Pinned
// by a test so nobody "fixes" one side alone.
const hasSubstance = (e) =>
  !!(e && (e.title || e.company || e.degree || e.school || e.name || e.description || "").trim?.());

// The CV with placeholder rows removed, for completeness purposes only. A read-time view;
// nothing here is ever persisted, so the real entries (and their _sortIds) are untouched.
//
// `skills` is deliberately NOT filtered — the client doesn't filter it either.
const withoutBlankEntries = (cv) => {
  if (!cv) return {};
  return {
    ...cv,
    experience: (cv.experience || []).filter(hasSubstance),
    projects: (cv.projects || []).filter(hasSubstance),
    education: (cv.education || []).filter(hasSubstance),
  };
};

// The five sections a CV needs before it is finished. `projects` is optional on the client
// and is optional here.
const isCvComplete = (cv) => {
  const view = withoutBlankEntries(cv);
  return (
    !!view.personalInfo?.fullName &&
    !!view.professionalSummary &&
    (view.experience?.length || 0) > 0 &&
    (view.education?.length || 0) > 0 &&
    (view.skills?.length || 0) > 0
  );
};

module.exports = { hasSubstance, withoutBlankEntries, isCvComplete };
