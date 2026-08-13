// The still-open must-haves Aria steers the interview by. `openMustHavesFromDraft` is
// exported as a PURE helper precisely so this can be asserted without a request, a
// draft document, or an AI round-trip.
//
// The point of the helper is that it delegates to the SCORING ENGINE's matcher
// (skillNormalizer.computeKeywordCoverage) rather than doing its own string search —
// so "covered while building" and "covered at scan time" can never disagree. The
// synonym case below is what actually proves that: a naive substring/equality check
// would report JavaScript as still-open when the bullet says "JS".
const { openMustHavesFromDraft } = require("../src/controllers/coach.controller");

// A draft shaped like the real DraftCV fields the helper reads.
const draftWith = (over = {}) => ({
  experience: [],
  projects: [],
  professionalSummary: "",
  skills: [],
  ...over,
});

const brief = (mustHaves) => ({ mustHaves });

const names = (out) => out.map((k) => k.name);

describe("openMustHavesFromDraft — what the role still needs", () => {
  const twoMustHaves = brief([
    { name: "Scheduling", importance: "must_have" },
    { name: "MS Excel", importance: "must_have" },
  ]);

  it("returns every must-have the draft does not mention yet", () => {
    const draft = draftWith({
      experience: [{ description: "Answered phones and greeted guests at the front desk." }],
    });

    const out = openMustHavesFromDraft(draft, twoMustHaves);

    expect(names(out)).toEqual(["Scheduling", "MS Excel"]);
    // Importance rides along so the prompt can weight them.
    expect(out[0]).toEqual({ name: "Scheduling", importance: "must_have" });
  });

  it("drops a must-have once a bullet covers it", () => {
    const draft = draftWith({
      experience: [{ description: "Tracked weekly bookings in MS Excel." }],
    });

    const out = openMustHavesFromDraft(draft, twoMustHaves);

    expect(names(out)).toEqual(["Scheduling"]);
  });

  it("drops a must-have named only in the skills list", () => {
    // Coverage is not bullets-only: the scan credits discrete skills, so the interview
    // must not keep digging for something already listed under Skills.
    const draft = draftWith({ skills: ["MS Excel", "Customer Service"] });

    expect(names(openMustHavesFromDraft(draft, twoMustHaves))).toEqual(["Scheduling"]);
  });

  it("reads skills given as {name} objects, not just strings", () => {
    const draft = draftWith({ skills: [{ name: "MS Excel" }, { name: "Filing" }] });

    expect(names(openMustHavesFromDraft(draft, twoMustHaves))).toEqual(["Scheduling"]);
  });

  it("counts a SYNONYM as covered — it reuses the scorer's matcher, not a substring search", () => {
    // The proof that this is the scoring engine's own matcher: "JS" in a bullet covers
    // the "JavaScript" must-have through the normalizer's synonym index. A hand-rolled
    // includes() would wrongly keep asking about JavaScript, and the later scan would
    // then contradict the interview.
    const draft = draftWith({
      experience: [{ description: "Wrote JS to validate the booking form." }],
    });

    const out = openMustHavesFromDraft(
      draft,
      brief([{ name: "JavaScript", importance: "must_have" }])
    );

    expect(out).toEqual([]);
  });

  it("also reads projects and the professional summary as covering text", () => {
    const fromProject = draftWith({ projects: [{ description: "Built a scheduling tool." }] });
    const fromSummary = draftWith({ professionalSummary: "Admin assistant handling scheduling." });

    expect(names(openMustHavesFromDraft(fromProject, twoMustHaves))).toEqual(["MS Excel"]);
    expect(names(openMustHavesFromDraft(fromSummary, twoMustHaves))).toEqual(["MS Excel"]);
  });

  it("returns [] when there is no brief, no must-haves, or a malformed one", () => {
    const draft = draftWith();

    expect(openMustHavesFromDraft(draft, null)).toEqual([]);
    expect(openMustHavesFromDraft(draft, undefined)).toEqual([]);
    expect(openMustHavesFromDraft(draft, {})).toEqual([]);
    expect(openMustHavesFromDraft(draft, brief([]))).toEqual([]);
    expect(openMustHavesFromDraft(draft, brief("not-an-array"))).toEqual([]);
  });

  it("survives a sparse draft (missing arrays, null descriptions)", () => {
    // Studio seeds placeholder rows before anything is written; a blank draft must not
    // throw, it must simply report everything as still open.
    const out = openMustHavesFromDraft({ experience: [{ description: null }, null] }, twoMustHaves);

    expect(names(out)).toEqual(["Scheduling", "MS Excel"]);
  });

  it("caps the list so the prompt can't be flooded by a long JD", () => {
    const many = brief(
      Array.from({ length: 12 }, (_, i) => ({ name: `Skill${i}`, importance: "must_have" }))
    );

    expect(openMustHavesFromDraft(draftWith(), many)).toHaveLength(6); // default cap
    expect(openMustHavesFromDraft(draftWith(), many, 2)).toHaveLength(2);
  });

  it("puts must-haves ahead of nice-to-haves before the cap is applied", () => {
    // With one slot, the genuine requirement must win over the optional extra.
    const mixed = brief([
      { name: "Nice To Have", importance: "nice_to_have" },
      { name: "Real Requirement", importance: "must_have" },
    ]);

    expect(names(openMustHavesFromDraft(draftWith(), mixed, 1))).toEqual(["Real Requirement"]);
  });
});
