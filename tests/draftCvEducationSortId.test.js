// DraftCV.education._sortId — the prerequisite for addressing an education entry.
//
// Mongoose STRICT MODE (on by default) drops any path the schema doesn't declare, at
// DOCUMENT-CAST time — so this is testable without a database: constructing the document
// is the exact moment the field would be stripped. Before the fix, `education` declared
// only degree/school/graduationDate/description, so every _sortId the Studio assigned to
// an education entry was silently discarded on save: the entry was un-addressable
// server-side (a pin self-healed away on reload) and the Live Preview keyed its rows on
// `undefined`. experience and projects never had that problem because both declare one.
//
// Deliberately NOT jest.mock'd (unlike the controller suites) — the schema itself is the
// unit under test here.
const DraftCV = require("../src/models/DraftCV");

const USER_ID = "60c72b2f9b1d8b2bad6e1a11";

const draftWith = (overrides = {}) =>
  new DraftCV({
    userId: USER_ID,
    title: "My CV",
    experience: [{ _sortId: "exp-1", title: "Analyst", company: "RSA" }],
    projects: [{ _sortId: "proj-1", title: "Analytical Engine" }],
    education: [
      { _sortId: "edu-1", degree: "BSc Mathematics", school: "UNILAG", graduationDate: "2024" },
    ],
    ...overrides,
  });

describe("DraftCV.education._sortId — survives a save (strict mode)", () => {
  it("KEEPS _sortId on an education entry through the document cast", () => {
    // The regression: this assertion fails on the pre-fix schema, because strict mode
    // strips the undeclared path before it can ever reach the database.
    const doc = draftWith();
    expect(doc.education[0]._sortId).toBe("edu-1");
    expect(doc.toObject().education[0]._sortId).toBe("edu-1");
  });

  it("keeps a DISTINCT id per entry, so entries stay individually addressable", () => {
    const doc = draftWith({
      education: [
        { _sortId: "edu-a", degree: "BSc", school: "UNILAG" },
        { _sortId: "edu-b", degree: "MSc", school: "UI" },
      ],
    });
    expect(doc.education.map((e) => e._sortId)).toEqual(["edu-a", "edu-b"]);
  });

  it("does not disturb the other education fields", () => {
    const entry = draftWith().toObject().education[0];
    expect(entry.degree).toBe("BSc Mathematics");
    expect(entry.school).toBe("UNILAG");
    expect(entry.graduationDate).toBe("2024");
  });

  it("still strips a genuinely undeclared field — proving strict mode is ON", () => {
    // Guards the test itself: if strict mode were off, the first assertion above would
    // pass for the wrong reason (everything survives), so the fix would be untested.
    const doc = draftWith({
      education: [{ _sortId: "edu-1", degree: "BSc", notAField: "should vanish" }],
    });
    expect(doc.toObject().education[0].notAField).toBeUndefined();
  });

  it("leaves _sortId undefined (not defaulted) when the client didn't send one", () => {
    // Legacy entries stay recognisably id-less, which is what the backfill script
    // (scripts/backfillEducationSortIds.js) keys off.
    const doc = draftWith({ education: [{ degree: "BSc", school: "UNILAG" }] });
    expect(doc.education[0]._sortId).toBeUndefined();
  });
});

describe("DraftCV — _sortId parity across the three entry lists", () => {
  it.each(["experience", "projects", "education"])(
    "'%s' declares a String _sortId on its subdocument schema",
    (path) => {
      const sortIdPath = DraftCV.schema.path(path).schema.path("_sortId");
      expect(sortIdPath).toBeDefined();
      expect(sortIdPath.instance).toBe("String");
    }
  );

  it("round-trips _sortId on all three lists in one document", () => {
    const saved = draftWith().toObject();
    expect(saved.experience[0]._sortId).toBe("exp-1");
    expect(saved.projects[0]._sortId).toBe("proj-1");
    expect(saved.education[0]._sortId).toBe("edu-1");
  });

  it("accepts the positional $set path the backfill script writes", () => {
    // The migration patches `education.<i>._sortId`. A strict UPDATE would drop an
    // unknown dotted path just as silently as a strict save, so assert the schema
    // resolves it.
    expect(DraftCV.schema.path("education.0._sortId")).toBeDefined();
  });
});
