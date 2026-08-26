// The THIRD way into the cross-history hunt: offered at the end of an entry interview,
// when the job asked for something this role turned out not to prove.
//
// The two existing entry points are both chips on the skills card, which means the offer
// only ever arrived long after the interview that discovered the gap. This closes that,
// and the decision of WHAT may be offered stays on the server for one reason: skillDeclines
// is the single mechanism enforcing "never ask again after a clear no", and a client
// re-deriving that list is exactly how a declined skill comes back.

const { huntOffersForEntry } = require("../src/controllers/coach.controller");

const REQ = (id, name, over = {}) => ({
  id,
  name,
  type: "tool",
  priority: "must_have",
  aliases: [],
  proofSignals: [],
  sourceText: `Experience with ${name}`,
  ...over,
});

const BRIEF = {
  role: "Property Manager",
  requirements: [REQ("req_a", "Yardi Voyager"), REQ("req_b", "Budget forecasting")],
};

// Two contexts minimum, or there is nowhere else to look.
const DRAFT = (over = {}) => ({
  experience: [
    { _sortId: "exp-1", title: "Assistant Manager", company: "Acorn" },
    { _sortId: "exp-2", title: "Administrator", company: "Brill" },
  ],
  projects: [],
  education: [],
  certifications: [],
  requirementProbes: [],
  skillDeclines: [],
  ...over,
});

const CHECKS = [
  { requirementId: "req_a", status: "not_demonstrated" },
  { requirementId: "req_b", status: "confirmed" },
];

describe("huntOffersForEntry", () => {
  it("offers a requirement this entry could not prove", () => {
    expect(huntOffersForEntry(DRAFT(), BRIEF, CHECKS)).toEqual([
      { requirementId: "req_a", name: "Yardi Voyager" },
    ]);
  });

  it("never offers one the interview DID prove", () => {
    const proved = [{ requirementId: "req_b", status: "confirmed" }];
    expect(huntOffersForEntry(DRAFT(), BRIEF, proved)).toEqual([]);
  });

  it("treats every non-'not_demonstrated' status as nothing to hunt", () => {
    for (const status of ["confirmed", "demonstrated", "related", "not_applicable"]) {
      expect(huntOffersForEntry(DRAFT(), BRIEF, [{ requirementId: "req_a", status }])).toEqual([]);
    }
  });

  // The rule the whole hunt rests on.
  it("never offers a requirement the user has already declined", () => {
    const draft = DRAFT({
      skillDeclines: [{ requirementId: "req_a", name: "Yardi Voyager", level: "never" }],
    });
    expect(huntOffersForEntry(draft, BRIEF, CHECKS)).toEqual([]);
  });

  it("never offers one that has already been hunted CV-wide", () => {
    // Including a hunt that came back DEFERRED — it was still asked, and asking the same
    // question again at the end of the next role is the nagging this guard prevents.
    for (const status of ["confirmed", "deferred", "declined"]) {
      const draft = DRAFT({
        requirementProbes: [{ requirementId: "req_a", name: "Yardi Voyager", status }],
      });
      expect(huntOffersForEntry(draft, BRIEF, CHECKS)).toEqual([]);
    }
  });

  it("stays silent when there is nowhere else to look", () => {
    // One context is the entry we just interviewed: a "hunt" would re-ask the question
    // the user has this moment answered.
    const draft = DRAFT({ experience: [{ _sortId: "exp-1", title: "Assistant", company: "Acorn" }] });
    expect(huntOffersForEntry(draft, BRIEF, CHECKS)).toEqual([]);
  });

  it("counts projects, education and certifications as places to look", () => {
    const draft = DRAFT({
      experience: [{ _sortId: "exp-1", title: "Assistant", company: "Acorn" }],
      education: [{ degree: "BSc Estate Management", school: "Unilag" }],
    });
    expect(huntOffersForEntry(draft, BRIEF, CHECKS)).toHaveLength(1);
  });

  it("caps the offers so the end of a role never becomes a checklist", () => {
    const brief = {
      requirements: ["a", "b", "c", "d"].map((k) => REQ(`req_${k}`, `Skill ${k}`)),
    };
    const checks = ["a", "b", "c", "d"].map((k) => ({
      requirementId: `req_${k}`,
      status: "not_demonstrated",
    }));
    expect(huntOffersForEntry(DRAFT(), brief, checks)).toHaveLength(2);
    expect(huntOffersForEntry(DRAFT(), brief, checks, 1)).toHaveLength(1);
  });

  it("ignores a check pointing at a requirement the brief no longer has", () => {
    // The JD was re-read and this requirement is gone; offering it would name something
    // the user is no longer being measured against.
    const checks = [{ requirementId: "req_gone", status: "not_demonstrated" }];
    expect(huntOffersForEntry(DRAFT(), BRIEF, checks)).toEqual([]);
  });

  it("is empty for a missing brief, missing checks, or a draft with no history", () => {
    expect(huntOffersForEntry(DRAFT(), null, CHECKS)).toEqual([]);
    expect(huntOffersForEntry(DRAFT(), BRIEF, [])).toEqual([]);
    expect(huntOffersForEntry(DRAFT(), BRIEF, undefined)).toEqual([]);
    expect(huntOffersForEntry({}, BRIEF, CHECKS)).toEqual([]);
  });

  it("skips a malformed check rather than throwing", () => {
    const checks = [null, { status: "not_demonstrated" }, { requirementId: "req_a", status: "not_demonstrated" }];
    expect(huntOffersForEntry(DRAFT(), BRIEF, checks)).toEqual([
      { requirementId: "req_a", name: "Yardi Voyager" },
    ]);
  });
});
