const {
  scanSections,
  bandOf,
  BAND_THRESHOLDS,
  SCAN_RULES_VERSION,
  classifyKeyword,
  scopeKeywords,
  keywordsForSection,
} = require("../src/services/sectionScan.service");
const { computeATSReadiness, SECTION_POINTS } = require("../src/services/atsCoach.service");

// A JD about wireline work — nothing in it overlaps a pastry chef's CV.
// NOTE: every keyword here is an ordinary tool/skill, so all three classify as
// 'general'. That is load-bearing for the education tests below: this job asks for no
// credential, so Education is scoped to zero keywords and falls back to quality alone.
const OILFIELD_JOB = {
  brief: {
    mustHaves: [{ name: "Python" }, { name: "SQL" }],
    niceToHaves: [{ name: "AWS" }],
  },
};

// A JD that asks for BOTH a school credential and a hands-on tool. The pair is the
// point: they must never appear in the same section's missing list.
const ACCOUNTING_JOB = {
  brief: {
    mustHaves: [{ name: "B.Sc in Accounting" }, { name: "Python" }],
  },
};

const sectionBy = (result, key) => result.sections.find((s) => s.key === key);

describe("sectionScan.scanSections", () => {
  describe("banding", () => {
    it("maps scores to bands at the documented boundaries", () => {
      expect(bandOf(100)).toBe("ok");
      expect(bandOf(75)).toBe("ok"); // inclusive lower edge of ok
      expect(bandOf(74)).toBe("warn");
      expect(bandOf(45)).toBe("warn"); // inclusive lower edge of warn
      expect(bandOf(44)).toBe("bad");
      expect(bandOf(0)).toBe("bad");
      expect(bandOf(null)).toBe("neutral");
    });

    it("uses the same thresholds the frontend bandOf does", () => {
      // Mirrors src/lib/applicationInsights.js:12-17. If either moves, this fails.
      expect(BAND_THRESHOLDS).toEqual({ ok: 75, warn: 45 });
    });

    it("bands every section it returns from that section's own score", () => {
      const { sections } = scanSections({}, {});
      expect(sections).toHaveLength(6);
      sections.forEach((s) => expect(s.band).toBe(bandOf(s.score)));
    });
  });

  describe("quality vs relevance", () => {
    // Complete, well-built, and about entirely the wrong trade.
    const pastryChef = {
      professionalSummary:
        "Pastry chef with eight years in fine dining. Ran a brigade of six, cut waste by 30%, and rebuilt the dessert menu twice a year around seasonal produce.",
      experience: [
        {
          title: "Head Pastry Chef",
          company: "Lagos Grand",
          description:
            "• Cut ingredient waste by 30%\n• Led a brigade of 6 across 200 covers a night",
        },
        { title: "Pastry Chef", company: "Bakery", description: "• Produced 400 units daily" },
      ],
      skills: [
        "Lamination",
        "Chocolate tempering",
        "Menu costing",
        "Food safety",
        "Team leadership",
        "Inventory",
        "Plating",
        "Viennoiserie",
        "Sourdough",
      ].map((name) => ({ name })),
      education: [{ degree: "Diploma", school: "Culinary Institute" }],
      projects: [{ title: "Seasonal menu", description: "• Rebuilt the dessert list" }],
      personalInfo: { fullName: "A Chef", email: "a@b.c", phone: "123", linkedin: "in/a" },
    };

    it("scores a complete-but-JD-irrelevant section high on quality, low on relevance", () => {
      const summary = sectionBy(scanSections(pastryChef, OILFIELD_JOB), "summary");

      expect(summary.quality).toBe(100); // 150+ chars — full marks on the rubric
      expect(summary.relevance).toBe(0); // mentions no Python, SQL or AWS
      expect(summary.score).toBe(50); // 50/50 blend
      expect(summary.band).toBe("warn");
      expect(summary.missingKeywords).toEqual(expect.arrayContaining(["Python", "SQL"]));
      expect(summary.note).toMatch(/well built/i);
    });

    it("separates the two failure modes in the note", () => {
      // Empty → a pure quality problem, said plainly.
      const empty = scanSections({ professionalSummary: "", personalInfo: {} }, OILFIELD_JOB);
      expect(sectionBy(empty, "summary").note).toMatch(/thin/i);

      // Half-written → still a quality problem FIRST, even though keywords are also
      // missing. It must never be described as "well built".
      const half = scanSections({ professionalSummary: "Chef.", personalInfo: {} }, OILFIELD_JOB);
      const note = sectionBy(half, "summary").note;
      expect(note).toMatch(/substance/i);
      expect(note).not.toMatch(/well built/i);

      // Complete but off-target → now, and only now, "well built but…".
      const complete = scanSections(
        { professionalSummary: "x".repeat(120), personalInfo: {} },
        OILFIELD_JOB
      );
      expect(sectionBy(complete, "summary").note).toMatch(/well built/i);
    });

    it("credits relevance when the section actually speaks to the job", () => {
      const dev = {
        ...pastryChef,
        professionalSummary:
          "Backend engineer with eight years building data services in Python and SQL, deployed on AWS across several production systems and teams.",
      };
      const summary = sectionBy(scanSections(dev, OILFIELD_JOB), "summary");

      expect(summary.relevance).toBe(100);
      expect(summary.score).toBe(100);
      expect(summary.band).toBe("ok");
      expect(summary.missingKeywords).toEqual([]);
    });

    it("measures each section against ITS OWN text, not the whole CV", () => {
      // Keywords live only in the skills section; the summary must not get credit.
      const draft = {
        professionalSummary: "Chef with eight years in fine dining and a steady record of results.",
        skills: [{ name: "Python" }, { name: "SQL" }, { name: "AWS" }],
        personalInfo: {},
      };
      const res = scanSections(draft, OILFIELD_JOB);

      expect(sectionBy(res, "skills").relevance).toBe(100);
      expect(sectionBy(res, "summary").relevance).toBe(0);
    });
  });

  describe("contact is JD-blind", () => {
    const complete = {
      education: [{ degree: "BSc", school: "UNIBEN" }],
      personalInfo: { fullName: "A", email: "a@b.c", phone: "1", linkedin: "in/a" },
    };

    // CONTACT keeps the original contract, permanently: no classification rule routes
    // any keyword to it, and RELEVANCE_WEIGHT.contact is 0 on top of that. A job
    // description cannot keyword-match a phone number.
    it("ignores keyword coverage for contact", () => {
      const s = sectionBy(scanSections(complete, OILFIELD_JOB), "contact");

      expect(s.quality).toBe(100);
      expect(s.score).toBe(100);
      expect(s.band).toBe("ok");
      expect(s.relevance).toBeNull(); // not measured — not zero
      expect(s.total).toBe(0);
    });

    // Education USED to share the assertion above unconditionally. It no longer does
    // (it now measures credential keywords — see "education measures only credentials"),
    // but it still behaves identically for a job like this one that asks for no
    // credential: zero scoped keywords → quality alone.
    it("scores contact and education identically with and without a job", () => {
      const withJob = scanSections(complete, OILFIELD_JOB);
      const without = scanSections(complete, {});

      ["contact", "education"].forEach((key) => {
        expect(sectionBy(withJob, key).score).toBe(sectionBy(without, key).score);
      });
      // The reason it still holds: this JD contains no credential/certification.
      expect(sectionBy(withJob, "education").total).toBe(0);
    });

    it("still marks a missing JD-blind section as bad", () => {
      const res = scanSections({ personalInfo: {} }, OILFIELD_JOB);
      expect(sectionBy(res, "education").score).toBe(0);
      expect(sectionBy(res, "education").band).toBe("bad");
    });
  });

  // ─── Keyword scoping ────────────────────────────────────────────────────────────
  // The bug this replaces: ONE job-wide keyword list was scored against every section,
  // so "B.Sc in Accounting" showed as missing from Summary, Work history, Skills AND
  // Projects at once — and Education, weighted 0, could never clear it.
  describe("keyword scoping", () => {
    // A candidate with the tool but not the degree.
    const analyst = {
      professionalSummary:
        "Finance analyst who closes the books on time and reports clean numbers to the board every quarter without fail.",
      experience: [
        { title: "Analyst", company: "Firm", description: "• Closed monthly books in 3 days" },
      ],
      skills: [{ name: "Excel" }, { name: "Reconciliations" }],
      education: [{ degree: "Diploma", school: "Culinary Institute" }],
      projects: [{ title: "Ledger cleanup", description: "• Rebuilt the chart of accounts" }],
      personalInfo: { fullName: "A", email: "a@b.c", phone: "1", linkedin: "in/a" },
    };

    it("routes a credential to education ONLY, and a tool to everywhere but education", () => {
      const res = scanSections(analyst, ACCOUNTING_JOB);

      // The tool is asked of the content sections…
      expect(sectionBy(res, "projects").missingKeywords).toContain("Python");
      expect(sectionBy(res, "projects").missingKeywords).not.toContain("B.Sc in Accounting");

      // …and the degree is asked ONLY of the section that can answer it.
      expect(sectionBy(res, "education").missingKeywords).toEqual(["B.Sc in Accounting"]);
      expect(sectionBy(res, "education").total).toBe(1);

      // No other section is ever told the user's degree is missing — clicking "Fix"
      // on Projects must never be about a school certificate.
      ["experience", "summary", "skills", "projects", "contact"].forEach((key) => {
        expect(sectionBy(res, key).missingKeywords).not.toContain("B.Sc in Accounting");
      });
      // Education is never asked for Python either — the scoping cuts both ways.
      expect(sectionBy(res, "education").missingKeywords).not.toContain("Python");
    });

    it("clears a credential the user actually holds, despite different wording", () => {
      // "B.Sc in Accounting" vs "BSc Accounting, University of Lagos" — whole-token
      // matching alone would never join these, so credentialCovered has to.
      const graduate = {
        ...analyst,
        education: [{ degree: "BSc Accounting", school: "University of Lagos" }],
      };
      const edu = sectionBy(scanSections(graduate, ACCOUNTING_JOB), "education");

      expect(edu.missingKeywords).toEqual([]);
      expect(edu.covered).toBe(1);
      expect(edu.relevance).toBe(100);
    });

    it("counts a certification typed into Skills for BOTH education and skills", () => {
      const PMP_JOB = { brief: { mustHaves: [{ name: "PMP" }] } };

      const uncertified = scanSections(analyst, PMP_JOB);
      expect(sectionBy(uncertified, "education").missingKeywords).toEqual(["PMP"]);
      expect(sectionBy(uncertified, "skills").missingKeywords).toEqual(["PMP"]);

      // Same person, certificate listed under Skills — where people actually put it.
      // It is one fact about one person, so it clears in both places.
      const certified = { ...analyst, skills: [{ name: "PMP" }, { name: "Excel" }] };
      const res = scanSections(certified, PMP_JOB);
      expect(sectionBy(res, "skills").missingKeywords).toEqual([]);
      expect(sectionBy(res, "education").missingKeywords).toEqual([]);

      // And it works from the certifications array too, which education's text now reads.
      const viaCerts = {
        ...analyst,
        certifications: [{ name: "PMP", issuer: "PMI" }],
      };
      const certRes = scanSections(viaCerts, PMP_JOB);
      expect(sectionBy(certRes, "education").missingKeywords).toEqual([]);
      expect(sectionBy(certRes, "skills").missingKeywords).toEqual([]);
    });

    it("education measures only credentials — a tool-only job leaves it unmeasured", () => {
      const res = scanSections(analyst, OILFIELD_JOB);
      const edu = sectionBy(res, "education");

      expect(edu.total).toBe(0);
      expect(edu.relevance).toBeNull(); // unmeasured, NOT zero
      expect(edu.score).toBe(edu.quality); // quality alone
    });

    it("weights education relevance at a quarter so one gap dents, not destroys", () => {
      // A complete education section (quality 100) missing the one credential asked of
      // it lands at 75, not 50 — a dent, not a red flag.
      const complete = {
        education: [{ degree: "HND Marketing", school: "Yaba Tech" }],
        personalInfo: {},
      };
      const edu = sectionBy(scanSections(complete, ACCOUNTING_JOB), "education");

      expect(edu.quality).toBe(100);
      expect(edu.relevance).toBe(0);
      expect(edu.score).toBe(75);
    });
  });

  describe("classifyKeyword", () => {
    // Every kind, plus the ordinary keywords that must fall through to the default.
    const FIXTURE = [
      "B.Sc",
      "BSc Accounting",
      "B.A. English",
      "M.Sc Finance",
      "MSc",
      "MBA",
      "Ph.D",
      "PhD Chemistry",
      "HND",
      "OND",
      "Bachelor's degree",
      "Master's degree",
      "Doctorate",
      "Degree in Economics",
      "Diploma",
      "WAEC",
      "NECO",
      "JAMB",
      "NYSC certificate",
      "SSCE",
      "A-Levels",
      "GCSE",
      "Graduate of an accredited university",
      "Certified Public Accountant",
      "AWS Certification",
      "Driver's licence",
      "ACCA",
      "ICAN",
      "CPA",
      "CFA",
      "PMP",
      "CISA",
      "CISSP",
      "CompTIA Security+",
      "PRINCE2",
      "Six Sigma Black Belt",
      "5+ years experience",
      "3 yrs in sales",
      "Communication",
      "Teamwork",
      "Attention to detail",
      "Problem-solving",
      "Interpersonal skills",
      "Time management",
      "Work ethic",
      "Self-motivated",
      "Python",
      "SQL",
      "AWS",
      "Stakeholder management",
      "Financial reporting",
      "IFRS",
    ];

    // THE invariant. An empty scope is the old bug in a new costume: a keyword nothing
    // can satisfy must be DROPPED, never fanned out to "everywhere".
    it("never scopes a keyword to zero sections", () => {
      FIXTURE.forEach((name) => {
        const { kind, sections } = classifyKeyword(name);
        expect(typeof kind).toBe("string");
        expect(Array.isArray(sections)).toBe(true);
        expect(sections.length).toBeGreaterThan(0);
      });
    });

    it("routes each kind to the sections that can satisfy it", () => {
      expect(classifyKeyword("NYSC certificate")).toEqual({
        kind: "credential",
        sections: ["education"],
      });
      expect(classifyKeyword("PMP")).toEqual({
        kind: "certification",
        sections: ["education", "skills"],
      });
      expect(classifyKeyword("5+ years experience")).toEqual({
        kind: "tenure",
        sections: ["experience", "summary"],
      });
      expect(classifyKeyword("Attention to detail")).toEqual({
        kind: "soft",
        sections: ["summary", "experience", "skills"],
      });
      expect(classifyKeyword("Python")).toEqual({
        kind: "general",
        sections: ["skills", "experience", "projects", "summary"],
      });
      expect(classifyKeyword("")).toEqual({
        kind: "general",
        sections: ["skills", "experience", "projects", "summary"],
      });
    });

    it("is ordered — the first matching rule wins", () => {
      // Contains BOTH a tenure phrase and a soft term; tenure is listed first.
      expect(classifyKeyword("10 years of leadership").kind).toBe("tenure");
      // Contains both a degree word and a certification word; credential is first.
      expect(classifyKeyword("Degree or professional certification").kind).toBe("credential");
    });

    it("word-boundaries the abbreviations so common words don't misfire", () => {
      // "BA" inside "database", "OND" inside "bond" — the classic false positives.
      expect(classifyKeyword("Database administration").kind).toBe("general");
      expect(classifyKeyword("Bond trading").kind).toBe("general");
    });

    it("hands back a fresh array so a caller cannot mutate the rule table", () => {
      classifyKeyword("NYSC").sections.push("projects");
      expect(classifyKeyword("NYSC").sections).toEqual(["education"]);
    });
  });

  describe("scopeKeywords / keywordsForSection", () => {
    const scoped = scopeKeywords([
      { name: "Python", importance: "must_have" },
      "NYSC certificate",
      { name: "" }, // dropped — no name, nothing to look for
    ]);

    it("tags each keyword with its kind and scope, dropping the nameless", () => {
      expect(scoped).toHaveLength(2);
      expect(scoped[0]).toEqual({
        name: "Python",
        importance: "must_have",
        kind: "general",
        sections: ["skills", "experience", "projects", "summary"],
      });
      // A bare string keyword defaults to nice_to_have rather than silently must_have.
      expect(scoped[1].importance).toBe("nice_to_have");
      expect(scoped[1].kind).toBe("credential");
    });

    it("hands each section only the keywords it is answerable for", () => {
      expect(keywordsForSection(scoped, "education").map((k) => k.name)).toEqual([
        "NYSC certificate",
      ]);
      expect(keywordsForSection(scoped, "projects").map((k) => k.name)).toEqual(["Python"]);
      expect(keywordsForSection(scoped, "contact")).toEqual([]);
    });
  });

  it("stamps a rules version so a stale persisted scan can be detected", () => {
    expect(Number.isInteger(SCAN_RULES_VERSION)).toBe(true);
    expect(SCAN_RULES_VERSION).toBeGreaterThan(0);
  });

  describe("with no job keywords at all", () => {
    it("falls back to quality alone rather than halving every score", () => {
      const draft = {
        professionalSummary: "x".repeat(120),
        personalInfo: { fullName: "A", email: "a@b.c", phone: "1", linkedin: "in/a" },
      };
      const summary = sectionBy(scanSections(draft, {}), "summary");

      expect(summary.quality).toBe(100);
      expect(summary.relevance).toBeNull();
      expect(summary.score).toBe(100); // NOT 50
    });
  });

  describe("quality subtotals stay faithful to the ATS rubric", () => {
    it("uses a fixed budget so an empty work history isn't flattered", () => {
      // The "Quantified achievements" check (15 of experience's 25) only fires when
      // bullets exist. Summing emitted checks would score 0/10 = 0... but so would a
      // CV with bullets and no numbers, hiding the difference. The fixed budget keeps
      // experience out of 25 either way.
      const noBullets = sectionBy(scanSections({ experience: [] }, {}), "experience");
      expect(noBullets.quality).toBe(0);

      const twoRolesNoMetrics = sectionBy(
        scanSections(
          { experience: [{ description: "• did a thing" }, { description: "• another" }] },
          {}
        ),
        "experience"
      );
      // 10 (2+ roles) + 0 (no metrics) out of the full 25.
      expect(twoRolesNoMetrics.quality).toBe(40);
    });

    it("never exceeds 100% for any section", () => {
      const maxed = {
        professionalSummary: "x".repeat(400),
        experience: [
          { description: "• Grew 30%\n• Cut 20%" },
          { description: "• Shipped 5 things" },
        ],
        skills: new Array(12).fill(0).map((_, i) => ({ name: `Skill ${i}` })),
        education: [{ degree: "BSc" }],
        projects: [{ title: "P" }],
        personalInfo: { fullName: "A", email: "a@b.c", phone: "1", linkedin: "in/a" },
      };
      scanSections(maxed, {}).sections.forEach((s) => {
        expect(s.quality).toBeLessThanOrEqual(100);
        expect(s.score).toBeLessThanOrEqual(100);
      });
    });

    it("keeps the per-check points reconciled with the overall ATS score", () => {
      // Guards the additive `points` tags in atsCoach.service: if a rule's points and
      // its check tag ever drift apart, quality subtotals silently go wrong.
      const drafts = [
        {},
        { professionalSummary: "short", skills: [{ name: "a" }], personalInfo: { fullName: "A" } },
        {
          professionalSummary: "x".repeat(120),
          experience: [{ description: "• Grew 30%" }, { description: "• More" }],
          skills: new Array(9).fill(0).map((_, i) => ({ name: `s${i}` })),
          education: [{ degree: "BSc" }],
          projects: [{ title: "p" }],
          personalInfo: { fullName: "A", email: "e", phone: "p", linkedin: "l" },
        },
      ];
      drafts.forEach((d) => {
        const { score, checks } = computeATSReadiness(null, d);
        const summed = checks.reduce((a, c) => a + (c.points || 0), 0);
        expect(summed).toBe(score);
        checks.forEach((c) => {
          expect(c.section).toBeDefined();
          expect(SECTION_POINTS[c.section]).toBeDefined();
        });
      });
    });

    it("budgets sum to 100", () => {
      expect(Object.values(SECTION_POINTS).reduce((a, b) => a + b, 0)).toBe(100);
    });
  });

  it("is pure — the same input scores the same twice", () => {
    const draft = { professionalSummary: "x".repeat(120), personalInfo: {} };
    expect(scanSections(draft, OILFIELD_JOB)).toEqual(scanSections(draft, OILFIELD_JOB));
  });
});

