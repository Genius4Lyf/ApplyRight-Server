// One answer to "does this CV cover this requirement?", and one honest fit-score sum.
//
// Three bugs closed here, all downstream of the same root cause — nobody owned the
// question, so three files answered it differently:
//
//   1. scoreSkills computed its earned weight TWICE, discarded the correct answer, and
//      recomputed it through a name lookup that could charge one requirement's weight
//      against another's. Only Math.min(100) kept the result plausible.
//   2. The skills panel matched requirements against skills with a plain substring test,
//      so "Excel" was satisfied by "Excellent written communication".
//   3. The JD's own aliases for a requirement were stripped before the scorer, the
//      keyword tracker and the uncovered-check ever saw them — so those three could only
//      match the single canonical name while Aria, reading the typed requirements, knew
//      better. Same word, two verdicts, same screen.
//
// All pure functions: no AI, no database, no network.

const {
  compareSkills,
  mentionsRequirement,
  requirementSurfaces,
  computeKeywordCoverage,
} = require("../src/services/skillNormalizer.service");
const { scoreSkills } = require("../src/services/scoringEngine.service");

describe("scoreSkills — the earned weight is a subset sum, not a second guess", () => {
  // The live trigger: computeFitScore merges requiredSkills and preferredSkills into ONE
  // list, so a posting naming the same skill twice at different priorities is ordinary,
  // not exotic. The old lookup resolved BOTH rows to the must-have and charged weight 2
  // twice, against a denominator holding 2 + 1.
  const DUPLICATE_NAMED_JD = [
    { name: "JavaScript", importance: "must_have" },
    { name: "JS", importance: "nice_to_have" },
    { name: "Kubernetes", importance: "must_have" },
    { name: "Terraform", importance: "must_have" },
  ];

  it("does not inflate when a posting names one skill twice", () => {
    // Honest ratio: JavaScript (2) + JS (1) earned of 2+1+2+2 = 7 → 43%.
    // Pre-fix this read 57%.
    expect(scoreSkills(["JavaScript"], DUPLICATE_NAMED_JD).score).toBe(43);
  });

  it("never exceeds 100 by construction, not by clamping", () => {
    // Every requirement lands in matched or missing exactly once, so the numerator is a
    // subset of the denominator. Hitting the clamp would mean that contract broke.
    const everything = DUPLICATE_NAMED_JD.map((r) => r.name);
    expect(scoreSkills(everything, DUPLICATE_NAMED_JD).score).toBe(100);
  });

  it("still weights a must-have at twice a nice-to-have", () => {
    const jd = [
      { name: "Kubernetes", importance: "must_have" },
      { name: "Terraform", importance: "nice_to_have" },
    ];
    // 2 of 3 vs 1 of 3 — the whole point of the weighting.
    expect(scoreSkills(["Kubernetes"], jd).score).toBe(67);
    expect(scoreSkills(["Terraform"], jd).score).toBe(33);
  });

  it("scores nothing matched as zero and no requirements as the neutral 50", () => {
    expect(scoreSkills(["Baking"], [{ name: "Kubernetes", importance: "must_have" }]).score).toBe(0);
    expect(scoreSkills(["Kubernetes"], []).score).toBe(50);
  });

  it("counts a JD alias as covered, so the score stops under-reporting", () => {
    // The other half of the same bug: without aliases this scored 0 for a candidate who
    // genuinely has the skill, because the generic synonym table has never heard of it.
    const jd = [{ name: "Yardi Voyager", importance: "must_have", aliases: ["Yardi"] }];
    expect(scoreSkills(["Yardi"], jd).score).toBe(100);
    expect(scoreSkills(["Yardi"], [{ name: "Yardi Voyager", importance: "must_have" }]).score).toBe(
      0
    );
  });
});

describe("compareSkills — JD aliases, and ids that map results back", () => {
  const YARDI = { id: "req_a1", name: "Yardi Voyager", importance: "must_have", aliases: ["Yardi"] };

  it("matches on an alias the posting itself used", () => {
    const { matched, missing } = compareSkills(["Yardi"], [YARDI]);
    expect(missing).toHaveLength(0);
    expect(matched[0]).toMatchObject({ id: "req_a1", matchedWith: "Yardi" });
  });

  it("carries the requirement id onto matched AND missing rows", () => {
    // Reverse-mapping by normalized name is ambiguous the moment two requirements share
    // a canonical, which is exactly the case that broke scoreSkills.
    const jd = [YARDI, { id: "req_b2", name: "Kubernetes", importance: "must_have" }];
    const { matched, missing } = compareSkills(["Yardi"], jd);
    expect(matched.map((m) => m.id)).toEqual(["req_a1"]);
    expect(missing.map((m) => m.id)).toEqual(["req_b2"]);
  });

  it("omits the id entirely for the plain { name, importance } callers", () => {
    const { matched } = compareSkills(["Kubernetes"], [{ name: "Kubernetes" }]);
    expect(matched[0]).not.toHaveProperty("id");
  });

  it("emits exactly one row per requirement — the invariant scoreSkills now relies on", () => {
    const jd = [
      { name: "JavaScript", importance: "must_have" },
      { name: "JS", importance: "nice_to_have" },
      { name: "Kubernetes", importance: "must_have" },
    ];
    const { matched, missing } = compareSkills(["JavaScript"], jd);
    expect(matched.length + missing.length).toBe(jd.length);
  });

  it("is unaffected by an empty or absent alias list", () => {
    expect(compareSkills(["Kubernetes"], [{ name: "Kubernetes", aliases: [] }]).matched).toHaveLength(
      1
    );
    expect(compareSkills(["Kubernetes"], [{ name: "Kubernetes" }]).matched).toHaveLength(1);
  });

  it("ignores blank aliases rather than matching everything", () => {
    // A defensive case that matters: an empty surface in a boundary regex matches any
    // text, which would mark every requirement covered.
    const { matched } = compareSkills(
      ["Baking"],
      [{ name: "Kubernetes", importance: "must_have", aliases: ["", "   "] }]
    );
    expect(matched).toHaveLength(0);
  });
});

describe("mentionsRequirement — the single free-text answer", () => {
  // The substring test the skills panel used to run. These are the cases it got wrong.
  it("refuses the substring false positives", () => {
    expect("excellent written communication".includes("excel")).toBe(true); // the old answer
    expect(mentionsRequirement("Excel", "Excellent written communication")).toBe(false);
    expect(mentionsRequirement("Java", "Built a JavaScript app")).toBe(false);
  });

  it("keeps the boundary behaviour the analysis pass had already got right", () => {
    expect(mentionsRequirement("Java", "Wrote Java services.")).toBe(true);
    expect(mentionsRequirement("C++", "Optimised C++ hot paths")).toBe(true);
    expect(mentionsRequirement("C#", "Ported to C#.")).toBe(true);
    expect(mentionsRequirement("Node.js", "Shipped a Node.js API")).toBe(true);
  });

  it("finds a requirement under a JD alias in free text", () => {
    const yardi = { name: "Yardi Voyager", aliases: ["Yardi"] };
    expect(mentionsRequirement(yardi, "Managed the portfolio in Yardi day to day")).toBe(true);
    expect(mentionsRequirement("Yardi Voyager", "Managed the portfolio in Yardi day to day")).toBe(
      false
    );
  });

  it("accepts a bare string, the compact shape, or a full typed requirement", () => {
    const text = "Ran the reporting in Excel";
    expect(mentionsRequirement("Excel", text)).toBe(true);
    expect(mentionsRequirement({ name: "Excel", importance: "must_have" }, text)).toBe(true);
    expect(
      mentionsRequirement({ id: "r1", name: "Excel", type: "tool", aliases: [] }, text)
    ).toBe(true);
  });

  it("is false for empty text and for a nameless requirement", () => {
    expect(mentionsRequirement("Excel", "")).toBe(false);
    expect(mentionsRequirement({ name: "" }, "Ran the reporting in Excel")).toBe(false);
    expect(mentionsRequirement("", "Ran the reporting in Excel")).toBe(false);
  });
});

describe("requirementSurfaces", () => {
  it("includes the name, its canonical form and every alias", () => {
    const surfaces = requirementSurfaces({ name: "Yardi Voyager", aliases: ["Yardi", "voyager"] });
    expect(surfaces.has("yardi voyager")).toBe(true);
    expect(surfaces.has("yardi")).toBe(true);
    expect(surfaces.has("voyager")).toBe(true);
  });

  it("returns an empty set for a nameless requirement", () => {
    expect(requirementSurfaces({ aliases: ["Yardi"] }).size).toBe(0);
    expect(requirementSurfaces("").size).toBe(0);
  });
});

describe("computeKeywordCoverage — now shares the same matcher", () => {
  it("counts an alias mentioned only in the bullets as covered", () => {
    const { results, covered } = computeKeywordCoverage(
      [{ name: "Yardi Voyager", importance: "must_have", aliases: ["Yardi"] }],
      { text: "Managed 400 units in Yardi", skills: [] }
    );
    expect(covered).toBe(1);
    expect(results[0].covered).toBe(true);
  });

  it("does not count a substring collision as coverage", () => {
    const { covered } = computeKeywordCoverage([{ name: "Java", importance: "must_have" }], {
      text: "Built a JavaScript app",
      skills: [],
    });
    expect(covered).toBe(0);
  });
});
