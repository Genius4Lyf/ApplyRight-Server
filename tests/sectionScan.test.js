const { scanSections, bandOf, BAND_THRESHOLDS } = require("../src/services/sectionScan.service");
const { computeATSReadiness, SECTION_POINTS } = require("../src/services/atsCoach.service");

// A JD about wireline work — nothing in it overlaps a pastry chef's CV.
const OILFIELD_JOB = {
  brief: {
    mustHaves: [{ name: "Python" }, { name: "SQL" }],
    niceToHaves: [{ name: "AWS" }],
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
          description: "• Cut ingredient waste by 30%\n• Led a brigade of 6 across 200 covers a night",
        },
        { title: "Pastry Chef", company: "Bakery", description: "• Produced 400 units daily" },
      ],
      skills: [
        "Lamination", "Chocolate tempering", "Menu costing", "Food safety",
        "Team leadership", "Inventory", "Plating", "Viennoiserie", "Sourdough",
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

  describe("JD-blind sections", () => {
    const complete = {
      education: [{ degree: "BSc", school: "UNIBEN" }],
      personalInfo: { fullName: "A", email: "a@b.c", phone: "1", linkedin: "in/a" },
    };

    it("ignores keyword coverage for contact and education", () => {
      const res = scanSections(complete, OILFIELD_JOB);

      // Neither mentions Python/SQL/AWS, yet both are perfect.
      ["contact", "education"].forEach((key) => {
        const s = sectionBy(res, key);
        expect(s.quality).toBe(100);
        expect(s.score).toBe(100);
        expect(s.band).toBe("ok");
        expect(s.relevance).toBeNull(); // not measured — not zero
        expect(s.total).toBe(0);
      });
    });

    it("scores contact and education identically with and without a job", () => {
      const withJob = scanSections(complete, OILFIELD_JOB);
      const without = scanSections(complete, {});

      ["contact", "education"].forEach((key) => {
        expect(sectionBy(withJob, key).score).toBe(sectionBy(without, key).score);
      });
    });

    it("still marks a missing JD-blind section as bad", () => {
      const res = scanSections({ personalInfo: {} }, OILFIELD_JOB);
      expect(sectionBy(res, "education").score).toBe(0);
      expect(sectionBy(res, "education").band).toBe("bad");
    });
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
        scanSections({ experience: [{ description: "• did a thing" }, { description: "• another" }] }, {}),
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
