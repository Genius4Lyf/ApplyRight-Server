const { hasSubstance, withoutBlankEntries, isCvComplete } = require("../src/utils/cvCompleteness");

// The server's copy of "is this CV finished?".
//
// It exists so POST /studio/duplicate can gate on the same thing the user is looking at,
// and its whole value is that it AGREES with the browser. The client rule lives in
// lib/cvCompleteness.js + lib/studioFlow.js; if the two ever drift, the Recents rail
// starts offering an action the endpoint refuses. These tests are what pin the agreement,
// including the one corner where the client's own predicate is quirky.
describe("hasSubstance", () => {
  it("accepts an entry carrying anything a reader would see", () => {
    expect(hasSubstance({ title: "Engineer" })).toBe(true);
    expect(hasSubstance({ company: "Acme" })).toBe(true);
    expect(hasSubstance({ degree: "BSc" })).toBe(true);
    expect(hasSubstance({ school: "Lagos" })).toBe(true);
    expect(hasSubstance({ name: "React" })).toBe(true);
    expect(hasSubstance({ description: "Did the thing" })).toBe(true);
  });

  it("rejects the placeholder row the Studio writes before the coach fills it", () => {
    // addRole() persists a bare _sortId so Aria has somewhere to write. That is not a role.
    expect(hasSubstance({ _sortId: "abc" })).toBe(false);
    expect(hasSubstance({})).toBe(false);
    expect(hasSubstance(null)).toBe(false);
    expect(hasSubstance(undefined)).toBe(false);
  });

  it("treats a whitespace-only field as empty", () => {
    expect(hasSubstance({ title: "   " })).toBe(false);
  });

  it("MIRRORS the client's short-circuit, including where that reads oddly", () => {
    // The `||` chain stops at the first TRUTHY field and trims only that one, so a
    // whitespace title masks a real company. This is faithful to studioFlow.js:118 ON
    // PURPOSE — a server stricter or looser than the browser in even one corner puts the
    // rail at odds with the chat beside it. If the client's predicate is ever fixed, fix
    // it here in the same change and update this test.
    expect(hasSubstance({ title: "   ", company: "Acme" })).toBe(false);
    // …and with no title at all, the company is reached normally.
    expect(hasSubstance({ company: "Acme" })).toBe(true);
  });
});

describe("withoutBlankEntries", () => {
  it("strips placeholders from experience, projects and education", () => {
    const view = withoutBlankEntries({
      experience: [{ title: "Engineer" }, { _sortId: "x" }],
      projects: [{ _sortId: "y" }],
      education: [{ school: "Lagos" }, {}],
    });
    expect(view.experience).toHaveLength(1);
    expect(view.projects).toHaveLength(0);
    expect(view.education).toHaveLength(1);
  });

  it("leaves skills alone, exactly as the client does", () => {
    const view = withoutBlankEntries({ skills: [{ name: "" }, { name: "React" }] });
    expect(view.skills).toHaveLength(2);
  });

  it("never mutates the CV it is given", () => {
    // A read-time view. The real entries and their _sortIds have to survive untouched —
    // Aria's per-entry writers address rows by those ids.
    const cv = { experience: [{ title: "Engineer" }, { _sortId: "x" }] };
    withoutBlankEntries(cv);
    expect(cv.experience).toHaveLength(2);
  });

  it("survives a null CV", () => {
    expect(withoutBlankEntries(null)).toEqual({});
  });
});

describe("isCvComplete", () => {
  const complete = () => ({
    personalInfo: { fullName: "Ada Lovelace" },
    professionalSummary: "Analytical engine specialist.",
    experience: [{ title: "Mathematician", company: "AEC" }],
    education: [{ degree: "BSc", school: "London" }],
    skills: [{ name: "Algorithms" }],
  });

  it("accepts a CV with all five required sections", () => {
    expect(isCvComplete(complete())).toBe(true);
  });

  it("does not require projects", () => {
    // Optional on the client, optional here.
    const cv = complete();
    expect(cv.projects).toBeUndefined();
    expect(isCvComplete(cv)).toBe(true);
  });

  it.each([
    ["a name", { personalInfo: {} }],
    ["a summary", { professionalSummary: "" }],
    ["experience", { experience: [] }],
    ["education", { education: [] }],
    ["skills", { skills: [] }],
  ])("refuses a CV missing %s", (_label, missing) => {
    expect(isCvComplete({ ...complete(), ...missing })).toBe(false);
  });

  it("REFUSES a CV whose only role is a blank placeholder", () => {
    // The case that separates this rule from the naive one. The sidebar and dashboard ask
    // only "is the array non-empty?", so they would call this finished; Aria Studio (and
    // therefore this) does not, because a row that exists solely to hold a _sortId is not
    // a job. Duplicating here would fork a CV the Studio still shows as an unfinished
    // build — the exact contradiction this rule exists to prevent.
    const cv = { ...complete(), experience: [{ _sortId: "placeholder" }] };
    expect(isCvComplete(cv)).toBe(false);
  });

  it("counts a real role sitting beside a placeholder", () => {
    const cv = { ...complete(), experience: [{ _sortId: "blank" }, { title: "Engineer" }] };
    expect(isCvComplete(cv)).toBe(true);
  });

  it("survives an empty or missing CV rather than throwing", () => {
    expect(isCvComplete({})).toBe(false);
    expect(isCvComplete(null)).toBe(false);
    expect(isCvComplete(undefined)).toBe(false);
  });
});
