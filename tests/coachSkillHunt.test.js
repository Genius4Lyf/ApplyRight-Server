// THE CROSS-HISTORY HUNT. When the employer wants something the CV hasn't shown, Aria
// looks for it across the user's WHOLE history before recording it as a gap — because
// people genuinely forget where they've done things.
//
// The line this must hold: push to UNCOVER forgotten experience, never push the user to
// CLAIM experience they don't have. These test the PURE helpers, so the ladder's rules are
// provable without an AI round-trip.
const coach = require("../src/controllers/coach.controller");
const {
  declinedRequirementKeys,
  huntContextsForDraft,
  buildHuntProbe,
  verifyProbeResult,
} = coach;

// A trade with no spreadsheets in sight, deliberately: nothing in this design is
// spreadsheet-shaped. The requirement is whatever THIS employer asked for.
const REQUIREMENT = {
  id: "req_triage",
  name: "Triage",
  type: "domain",
  priority: "must_have",
  aliases: ["Triage assessment"],
  proofSignals: ["prioritised patients", "assessed on arrival"],
  sourceText: "Experience with triage in an emergency setting required.",
};

const CERT_REQUIREMENT = {
  id: "req_bls",
  name: "BLS Certification",
  type: "certification",
  priority: "must_have",
  aliases: [],
  proofSignals: ["resuscitation"],
  sourceText: "BLS certification required.",
};

const BRIEF = { requirements: [REQUIREMENT, CERT_REQUIREMENT] };

const draft = (over = {}) => ({
  experience: [
    { _sortId: "e1", title: "Ward Nurse", company: "St Mary's" },
    { _sortId: "e2", title: "Care Assistant", company: "Oak Lodge", entryType: "part-time" },
  ],
  projects: [{ _sortId: "p1", title: "Final-year care study" }],
  education: [{ degree: "BSc", field: "Nursing", school: "UNILAG" }],
  certifications: [{ name: "First Aid" }],
  skillDeclines: [],
  ...over,
});

describe("huntContextsForDraft — every place the hunt may ask about", () => {
  it("spans jobs, projects, education and training", () => {
    const contexts = huntContextsForDraft(draft());
    const kinds = contexts.map((c) => c.kind);

    expect(kinds).toContain("experience");
    expect(kinds).toContain("project");
    expect(kinds).toContain("education");
    expect(kinds).toContain("training");
    expect(contexts.find((c) => c.sortId === "e1").label).toBe("Ward Nurse at St Mary's");
  });

  it("keeps a non-job entry's own kind, so an internship isn't framed as a job", () => {
    const contexts = huntContextsForDraft(draft());
    expect(contexts.find((c) => c.sortId === "e2").kind).toBe("part-time");
  });

  it("skips rows with nothing to name", () => {
    const contexts = huntContextsForDraft(
      draft({ experience: [{ _sortId: "e9", title: "", company: "" }] })
    );
    expect(contexts.some((c) => c.sortId === "e9")).toBe(false);
  });
});

describe("buildHuntProbe — what may be asked, and what may not", () => {
  it("builds a probe carrying the requirement and the JD's own words", () => {
    const probe = buildHuntProbe(draft(), BRIEF, "req_triage");

    expect(probe.name).toBe("Triage");
    expect(probe.sourceText).toMatch(/emergency setting/);
    expect(probe.contexts.length).toBeGreaterThan(2);
  });

  // The single mechanism behind "she doesn't keep asking after you've said no".
  it("REFUSES to build a probe for something already declined", () => {
    const d = draft({
      skillDeclines: [{ requirementId: "req_triage", name: "Triage", level: "never" }],
    });
    expect(buildHuntProbe(d, BRIEF, "req_triage")).toBeNull();
  });

  it("returns null for an unknown requirement rather than inventing one", () => {
    expect(buildHuntProbe(draft(), BRIEF, "req_nope")).toBeNull();
    expect(buildHuntProbe(draft(), { requirements: [] }, "req_triage")).toBeNull();
  });
});

describe("declinedRequirementKeys", () => {
  it("indexes declines by name, case-insensitively", () => {
    const keys = declinedRequirementKeys(
      draft({ skillDeclines: [{ name: "Triage" }, { name: "Wound Care" }] })
    );
    expect(keys.has("triage")).toBe(true);
    expect(keys.has("wound care")).toBe(true);
  });

  it("is empty for a draft that has never declined anything", () => {
    expect(declinedRequirementKeys(draft()).size).toBe(0);
    expect(declinedRequirementKeys(undefined).size).toBe(0);
  });
});

describe("verifyProbeResult — the honesty ladder is verified, not trusted", () => {
  const turns = [
    { who: "aria", text: "Have you done triage anywhere?" },
    {
      who: "user",
      text: "Yes, I ran triage on the night shift at St Mary's for about a year.",
    },
  ];
  const evidence = [
    {
      claim: "Ran triage on nights",
      sourceQuote: "I ran triage on the night shift at St Mary's",
    },
  ];

  it("accepts a quote the user really typed that NAMES the requirement", () => {
    const verdict = verifyProbeResult({
      probeResult: { level: "regular", evidenceIndex: 0 },
      evidence,
      turns,
      probe: REQUIREMENT,
    });

    expect(verdict.verified).toBe(true);
    expect(verdict.level).toBe("regular");
    expect(verdict.evidence.sourceQuote).toMatch(/I ran triage/);
  });

  // THE most important test here. A cross-history hunt is exactly the situation that
  // tempts a model to treat an adjacent activity as proof.
  it("REJECTS a proof-signal-only claim — adjacent activity is not evidence", () => {
    const softTurns = [
      { who: "user", text: "I prioritised patients as they came in, but I never did triage formally." },
    ];
    const verdict = verifyProbeResult({
      probeResult: { level: "regular", evidenceIndex: 0 },
      evidence: [
        { claim: "Prioritised patients", sourceQuote: "I prioritised patients as they came in" },
      ],
      turns: softTurns,
      probe: REQUIREMENT,
    });

    // The quote is real, but it never names the requirement — only a proof signal.
    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toBeNull();
  });

  it("REJECTS a quote the user never actually typed", () => {
    const verdict = verifyProbeResult({
      probeResult: { level: "regular", evidenceIndex: 0 },
      evidence: [{ claim: "Did triage", sourceQuote: "I led the triage department for six years" }],
      turns,
      probe: REQUIREMENT,
    });
    expect(verdict.verified).toBe(false);
  });

  it("accepts an ALIAS as naming the requirement", () => {
    const aliasTurns = [
      { who: "user", text: "I did triage assessment every shift on the ward." },
    ];
    const verdict = verifyProbeResult({
      probeResult: { level: "basic", evidenceIndex: 0 },
      evidence: [
        { claim: "Triage assessment", sourceQuote: "I did triage assessment every shift" },
      ],
      turns: aliasTurns,
      probe: REQUIREMENT,
    });
    expect(verdict.verified).toBe(true);
  });

  it("REJECTS an addable rung with no evidence at all", () => {
    const verdict = verifyProbeResult({
      probeResult: { level: "coursework", evidenceIndex: null },
      evidence: [],
      turns,
      probe: REQUIREMENT,
    });
    expect(verdict.verified).toBe(false);
  });

  // Declines only ever REMOVE things, so demanding proof of a "no" would be absurd —
  // and would leave a user unable to say no cleanly.
  it("accepts 'encountered' and 'never' with no evidence in a BUILD-posture hunt", () => {
    // They were asked a direct question mid-interview, so a decline needs no quote.
    ["encountered", "never"].forEach((level) => {
      const verdict = verifyProbeResult({
        probeResult: { level },
        evidence: [],
        turns: [],
        probe: { ...REQUIREMENT, mode: "build" },
      });
      expect(verdict).toEqual({ level, verified: true, evidence: null });
    });
  });

  it("treats a probe with NO posture as the safe one, not the permissive one", () => {
    // The defaulting must match buildHuntProbe's. Getting this backwards would let a probe
    // assembled anywhere else silence a requirement by omission.
    ["encountered", "never"].forEach((level) => {
      expect(
        verifyProbeResult({ probeResult: { level }, evidence: [], turns: [], probe: REQUIREMENT })
      ).toMatchObject({ verified: false });
    });
  });

  it("ignores a rung the ladder does not define", () => {
    expect(
      verifyProbeResult({
        probeResult: { level: "sort of", evidenceIndex: 0 },
        evidence,
        turns,
        probe: REQUIREMENT,
      })
    ).toBeNull();
    expect(
      verifyProbeResult({ probeResult: null, evidence, turns, probe: REQUIREMENT })
    ).toBeNull();
  });

  it("holds the same line for a certification", () => {
    const certTurns = [{ who: "user", text: "I hold a current BLS certification from 2024." }];
    const good = verifyProbeResult({
      probeResult: { level: "regular", evidenceIndex: 0 },
      evidence: [{ claim: "Holds BLS", sourceQuote: "I hold a current BLS certification" }],
      turns: certTurns,
      probe: CERT_REQUIREMENT,
    });
    expect(good.verified).toBe(true);

    const bad = verifyProbeResult({
      probeResult: { level: "regular", evidenceIndex: 0 },
      evidence: [{ claim: "Did resuscitation", sourceQuote: "I have done resuscitation" }],
      turns: [{ who: "user", text: "I have done resuscitation on the ward." }],
      probe: CERT_REQUIREMENT,
    });
    expect(bad.verified).toBe(false);
  });
});

describe("declines are honoured by the entry interview too, not just the hunt", () => {
  it("drops a declined requirement from the interview's ranked leads", () => {
    const d = draft({
      skills: [],
      skillDeclines: [{ requirementId: "req_triage", name: "Triage", level: "never" }],
    });
    const brief = {
      ...BRIEF,
      mustHaves: [{ name: "Triage", importance: "must_have" }],
      niceToHaves: [],
    };

    const leads = coach.targetRequirementsForEntry(
      d,
      brief,
      { title: "Ward Nurse", _sortId: "e1" },
      [{ who: "user", text: "I looked after patients on the ward." }],
      3
    );

    expect(leads.some((lead) => lead.name === "Triage")).toBe(false);
  });
});

// ── The two postures ──────────────────────────────────────────────────────────────────
//
// The hunt now has one job in two moods. It presses for an answer only where an answer has
// somewhere to go — mid-interview on an entry, where a verdict becomes a bullet. Tapping a
// requirement on the job checklist at any other moment is curiosity, and the cost of getting
// that wrong is not symmetric: a wrongly-recorded "never" silences the requirement on EVERY
// surface, permanently, for someone who was only asking what it meant.
describe("buildHuntProbe — posture", () => {
  it("carries an explicit build posture through", () => {
    expect(buildHuntProbe(draft(), BRIEF, "req_triage", "build").mode).toBe("build");
  });

  it("defaults to the posture that cannot do harm", () => {
    // No mode, an unknown mode, or a junk value → 'open'. Nothing is silenced by accident.
    expect(buildHuntProbe(draft(), BRIEF, "req_triage").mode).toBe("open");
    expect(buildHuntProbe(draft(), BRIEF, "req_triage", "interrogate").mode).toBe("open");
    expect(buildHuntProbe(draft(), BRIEF, "req_triage", null).mode).toBe("open");
  });

  it("still refuses a requirement already declined, in either posture", () => {
    const declined = draft({
      skillDeclines: [{ requirementId: "req_triage", name: "Triage", level: "never" }],
    });
    expect(buildHuntProbe(declined, BRIEF, "req_triage", "build")).toBeNull();
    expect(buildHuntProbe(declined, BRIEF, "req_triage", "open")).toBeNull();
  });
});

describe("verifyProbeResult — a decline must be earned in the OPEN posture", () => {
  const probe = (mode) => buildHuntProbe(draft(), BRIEF, "req_triage", mode);
  const said = (text) => [{ who: "user", text }];

  it("accepts an unevidenced decline mid-interview, where they were asked directly", () => {
    const verdict = verifyProbeResult({
      probeResult: { level: "never" },
      evidence: [],
      turns: said("no"),
      probe: probe("build"),
    });
    expect(verdict).toMatchObject({ level: "never", verified: true });
  });

  it("REFUSES an unevidenced decline in an exploring conversation", () => {
    // The harm this prevents: someone taps a requirement to find out what it is, gives a
    // shrug, and the model reports "never" — silencing it everywhere, forever.
    const verdict = verifyProbeResult({
      probeResult: { level: "never" },
      evidence: [],
      turns: said("hmm not sure what that means really"),
      probe: probe("open"),
    });
    expect(verdict).toMatchObject({ level: "never", verified: false });
  });

  it("accepts an open decline when the user plainly said it, naming the thing", () => {
    const verdict = verifyProbeResult({
      probeResult: { level: "never", evidenceIndex: 0 },
      evidence: [{ sourceQuote: "I have never done triage" }],
      turns: said("I have never done triage, not once"),
      probe: probe("open"),
    });
    expect(verdict).toMatchObject({ level: "never", verified: true });
  });

  it("refuses an open decline whose quote does not name the requirement", () => {
    // Adjacency is not an answer — the same rule that already protects a CLAIM.
    const verdict = verifyProbeResult({
      probeResult: { level: "never", evidenceIndex: 0 },
      evidence: [{ sourceQuote: "I worked nights" }],
      turns: said("I worked nights"),
      probe: probe("open"),
    });
    expect(verdict).toMatchObject({ verified: false });
  });

  it("leaves a CLAIM held to the same bar in both postures", () => {
    for (const mode of ["build", "open"]) {
      expect(
        verifyProbeResult({
          probeResult: { level: "regular", evidenceIndex: 0 },
          evidence: [{ sourceQuote: "I ran triage every shift" }],
          turns: said("I ran triage every shift"),
          probe: probe(mode),
        })
      ).toMatchObject({ verified: true });

      expect(
        verifyProbeResult({
          probeResult: { level: "regular", evidenceIndex: 0 },
          evidence: [{ sourceQuote: "I prioritised patients" }],
          turns: said("I prioritised patients"),
          probe: probe(mode),
        })
      ).toMatchObject({ verified: false });
    }
  });
});
