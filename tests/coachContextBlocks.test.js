const { briefBlock, scanBlock, redFlagBlock, cvDigest } = require("../src/services/ai.service");

// Context Aria always had access to and was throwing away one line before the model call.
//
// These assert the exact prompt fragment, the way careerStage.test.js and
// screenContext.test.js do — the fragment IS what the model is told, so asserting on the
// string is a faithful proxy for her behaviour without an AI round-trip.
//
// Two properties matter across all four: they cost nothing when there is nothing to say
// (an empty string, so an unscanned CV's prompt reads exactly as it did before), and they
// are BOUNDED, because they ride on every single turn.

const BRIEF = {
  role: "Field Engineer",
  company: "Halliburton",
  companyType: "multinational",
  industry: "Oil & gas services",
  seniority: "mid",
  yearsRequired: 3,
  requiredEducation: { degree: "BEng", field: "Engineering" },
  mustHaves: [
    { name: "Cased-hole logging", importance: "critical" },
    { name: "SQL", importance: "preferred" },
  ],
  niceToHaves: [{ name: "Python" }],
  responsibilities: ["Run logging operations on site", "Report results to the client daily"],
};

const SCAN = {
  fitScore: 61,
  recommendation: "Worth applying",
  missingSkills: [{ name: "SQL" }],
  evidence: [{ quote: "Responsible for rig-up", issue: "Passive", fix: "Say what happened" }],
  sections: [
    { key: "experience", label: "Work history", band: "warn", score: 62 },
    { key: "skills", label: "Skills", band: "bad", score: 31 },
    { key: "summary", label: "Summary", band: "ok", score: 80 },
  ],
  scannedAt: "2026-09-01T10:00:00.000Z",
};

describe("briefBlock", () => {
  it("carries the parts of the brief that used to be dropped", () => {
    // Before this, the whole brief was flattened to role + company + a comma list of
    // must-have NAMES — while all of the below sat on the same cached object.
    const out = briefBlock(BRIEF);

    expect(out).toContain("mid level");
    expect(out).toContain("~3+ years");
    expect(out).toContain("BEng in Engineering");
    expect(out).toContain("Oil & gas services");
    expect(out).toContain("Cased-hole logging (critical)");
    expect(out).toContain("Run logging operations on site");
  });

  it("marks nice-to-haves as not required, so they cannot be coached as gaps", () => {
    expect(briefBlock(BRIEF)).toContain("NICE TO HAVE (never treat as required): Python");
  });

  it("caps every list so a long JD cannot swamp the prompt", () => {
    const many = (n, prefix) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}` }));
    const out = briefBlock({
      ...BRIEF,
      mustHaves: many(40, "must"),
      niceToHaves: many(40, "nice"),
      responsibilities: Array.from({ length: 40 }, (_, i) => `does thing ${i}`),
    });

    expect(out).toContain("must11");
    expect(out).not.toContain("must12");
    expect(out).not.toContain("nice6");
    expect(out).not.toContain("does thing 6");
  });

  it("says nothing at all with no brief", () => {
    expect(briefBlock(null)).toBe("");
    expect(briefBlock(undefined)).toBe("");
  });
});

describe("scanBlock", () => {
  it("reports the score, the bands and the named fixes", () => {
    const out = scanBlock(SCAN);

    expect(out).toContain("fit 61%");
    expect(out).toContain("Work history amber (62)");
    expect(out).toContain("Skills red (31)");
    expect(out).toContain("Summary green (80)");
    expect(out).toContain("SQL");
    expect(out).toContain("Say what happened");
  });

  it("never states a score without the date it was taken", () => {
    // The load-bearing rule. A scan is a snapshot and the CV may have moved since; a score
    // quoted as live is a confident lie, which is worse than no score.
    const out = scanBlock(SCAN);

    expect(out).toContain("2026-09-01");
    expect(out).toContain("SNAPSHOT");
    expect(out).toContain("as of your last scan");
    expect(out).toContain("NEVER invent or estimate a score");
  });

  it("prefers the recompute date when the scan has been re-run", () => {
    const out = scanBlock({ ...SCAN, recomputedAt: "2026-09-05T10:00:00.000Z" });

    expect(out).toContain("2026-09-05");
    expect(out).not.toContain("2026-09-01");
  });

  it("says nothing for a CV that has never been scanned", () => {
    expect(scanBlock(null)).toBe("");
    expect(scanBlock({})).toBe("");
    expect(scanBlock({ sections: [] })).toBe("");
  });
});

describe("redFlagBlock", () => {
  const flags = [
    { label: "Duplicate skills", detail: "Excel appears twice.", severity: "low" },
    { label: "Passive openers", detail: "2 bullets start with Responsible for.", severity: "high" },
    {
      label: "Few quantified results",
      detail: "Only 1/5 bullets have a number.",
      severity: "medium",
    },
  ];

  it("renders the findings worst-first", () => {
    const out = redFlagBlock(flags);

    expect(out.indexOf("Passive openers")).toBeLessThan(out.indexOf("Few quantified results"));
    expect(out.indexOf("Few quantified results")).toBeLessThan(out.indexOf("Duplicate skills"));
  });

  it("frames them as facts and forbids inventing more", () => {
    // These come from detectRedFlags — mechanical checks over the document, not model
    // opinion. That distinction is the whole reason they are worth putting in the prompt.
    const out = redFlagBlock(flags);

    expect(out).toContain("checked mechanically");
    expect(out).toContain("Do not invent flags beyond this list");
  });

  it("says nothing for a clean CV", () => {
    expect(redFlagBlock([])).toBe("");
    expect(redFlagBlock(null)).toBe("");
    expect(redFlagBlock([{ label: "no detail" }])).toBe("");
  });
});

describe("cvDigest", () => {
  const draft = {
    professionalSummary: "Wireline engineer, four years cased-hole.",
    experience: [
      {
        title: "Field Engineer",
        company: "Schlumberger",
        startDate: "2022",
        isCurrent: true,
        description: "• Ran logging on 30+ wells\n• Built the daily report in Excel",
      },
      { title: "Trainee", company: "Baker Hughes", startDate: "2021", endDate: "2022" },
    ],
    projects: [{ title: "Log QC dashboard", description: "• Python script" }],
    education: [{ degree: "BEng", school: "UNIPORT", graduationDate: "2020" }],
    skills: [{ name: "Logging" }, { name: "Excel" }],
  };

  it("shows what each role actually says, not just how many there are", () => {
    // The point of the change: mid-interview on role 2, Aria can now see role 1's text.
    const out = cvDigest(draft, "Field Engineer");

    expect(out).toContain("Field Engineer at Schlumberger");
    expect(out).toContain("Ran logging on 30+ wells");
    expect(out).toContain("Trainee at Baker Hughes (2021–2022)");
    expect(out).toContain("Log QC dashboard");
    expect(out).toContain("BEng — UNIPORT");
    expect(out).toContain("Logging, Excel");
  });

  it("marks an open current role as running to the present", () => {
    expect(cvDigest(draft)).toContain("(2022–present)");
  });

  it("does not double the bullet marker already stored in the description", () => {
    expect(cvDigest(draft)).not.toContain("• •");
  });

  it("names the empty parts instead of hiding them", () => {
    // "no bullets yet" is a coaching cue; silence would read as "this role is fine".
    const out = cvDigest({ experience: [{ title: "Intern", company: "NNPC" }] });

    expect(out).toContain("no bullets yet");
    expect(out).toContain("Summary: (not written yet)");
    expect(out).toContain("Skills listed: (none yet)");
  });

  it("stays bounded — this rides on every single turn", () => {
    const out = cvDigest({
      experience: Array.from({ length: 30 }, (_, i) => ({
        title: `Role ${i}`,
        company: "Acme",
        description: "x".repeat(4000),
      })),
      skills: Array.from({ length: 200 }, (_, i) => ({ name: `skill${i}` })),
    });

    expect(out).toContain("Role 7");
    expect(out).not.toContain("Role 8");
    expect(out).toContain("(+22 more)");
    expect(out).not.toContain("skill40");
    // A pathological CV must not blow the prompt open.
    expect(out.length).toBeLessThan(3000);
  });

  it("handles an empty draft without throwing", () => {
    expect(() => cvDigest({})).not.toThrow();
    expect(() => cvDigest()).not.toThrow();
  });
});
