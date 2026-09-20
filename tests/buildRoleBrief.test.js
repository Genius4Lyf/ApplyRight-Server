const { roleBriefFromExtraction } = require("../src/services/ai.service");

// The job description → Role Brief mapping had NO direct test: every suite that touches
// buildRoleBrief mocks it, so its caps, its type whitelist and the composition of
// `requirements` were all unasserted. These pin the pure half.
//
// The fixture is the real extraction from a real posting (Renaissance Africa Energy,
// Operations & Maintenance Technician) — including the defect it exposed: the parser
// returned the DEGREE FIELDS as must-have skills.
const EXTRACTION = {
  detectedJobTitle: "Operations and Maintenance Technician",
  detectedCompany: "Renaissance Africa Energy Company Limited",
  companyType: "enterprise",
  industry: "energy",
  seniorityLevel: "mid",
  requiredYearsExperience: 2,
  requiredEducation: {
    degree: "Ordinary National Diploma (OND/ND)",
    field: "Electrical Engineering, Mechanical Engineering, Instrumentation, Electronics, Sciences",
  },
  requiredSkills: [
    { name: "Electrical Engineering", type: "domain", importance: "must_have" },
    { name: "Mechanical Engineering", type: "domain", importance: "must_have" },
    {
      name: "Permit-to-Work",
      type: "method",
      importance: "must_have",
      aliases: ["PTW"],
      proofSignals: ["task risk assessment"],
      sourceText: "Competence in Permit-to-Work, task risk assessment and safe isolation",
    },
    { name: "Troubleshooting", type: "skill", importance: "must_have" },
  ],
  preferredSkills: [{ name: "Upstream Oil and Gas Production", type: "domain" }],
  keyResponsibilities: ["Operating oil and gas facilities safely", "Collecting field data"],
};

describe("roleBriefFromExtraction", () => {
  it("lets the caller's title win over the detected one", () => {
    expect(roleBriefFromExtraction(EXTRACTION, "Field Technician").role).toBe("Field Technician");
    expect(roleBriefFromExtraction(EXTRACTION).role).toBe("Operations and Maintenance Technician");
  });

  it("carries the parts the scorer and the prompts depend on", () => {
    const brief = roleBriefFromExtraction(EXTRACTION);
    expect(brief.company).toBe("Renaissance Africa Energy Company Limited");
    expect(brief.companyType).toBe("enterprise");
    expect(brief.yearsRequired).toBe(2);
    // Dropping this silently scored every recompute's education against null.
    expect(brief.requiredEducation.degree).toBe("Ordinary National Diploma (OND/ND)");
  });

  it("defaults companyType and seniority rather than emitting undefined", () => {
    const brief = roleBriefFromExtraction({});
    expect(brief.companyType).toBe("unknown");
    expect(brief.seniority).toBe("mid");
    expect(brief.yearsRequired).toBe(0);
    expect(brief.requiredEducation).toBeNull();
    expect(brief.requirements).toEqual([]);
  });

  // The defect a real posting exposed: three of seven must-haves were degree fields, which
  // are alternatives you HOLD, not work you DID.
  describe("qualifications", () => {
    it("marks a must-have that is really the field of the required qualification", () => {
      const brief = roleBriefFromExtraction(EXTRACTION);
      const byName = Object.fromEntries(brief.mustHaves.map((m) => [m.name, m]));
      expect(byName["Electrical Engineering"].qualification).toBe(true);
      expect(byName["Mechanical Engineering"].qualification).toBe(true);
    });

    it("leaves a real competency unmarked", () => {
      const brief = roleBriefFromExtraction(EXTRACTION);
      const byName = Object.fromEntries(brief.mustHaves.map((m) => [m.name, m]));
      expect(byName["Permit-to-Work"].qualification).toBeUndefined();
      expect(byName.Troubleshooting.qualification).toBeUndefined();
    });

    it("keeps qualifications IN the compact arrays — scoring must be untouched", () => {
      // sectionScan routes credential words to the education section on purpose, and
      // scoreEducation reads requiredEducation separately. The flag changes what Aria
      // asks about, not what anything scores.
      const brief = roleBriefFromExtraction(EXTRACTION);
      expect(brief.mustHaves).toHaveLength(4);
    });

    it("marks the same item on the typed requirements list", () => {
      const brief = roleBriefFromExtraction(EXTRACTION);
      const typed = brief.requirements.find((r) => r.name === "Electrical Engineering");
      expect(typed.qualification).toBe(true);
      // A flag, never a new `type` — requirementId hashes the type, so retyping would
      // change the id and strand every requirementCheck already pointing at it.
      expect(typed.type).toBe("domain");
    });

    it("does not mark anything when the posting states no education requirement", () => {
      const brief = roleBriefFromExtraction({ ...EXTRACTION, requiredEducation: null });
      expect(brief.mustHaves.every((m) => !m.qualification)).toBe(true);
    });

    it("never marks a one- or two-character name, which would match almost anything", () => {
      const brief = roleBriefFromExtraction({
        requiredEducation: { degree: "BSc", field: "Computer Science" },
        requiredSkills: [
          { name: "R", type: "technology" },
          { name: "C", type: "technology" },
        ],
      });
      expect(brief.mustHaves.every((m) => !m.qualification)).toBe(true);
    });
  });

  // Running ten real postings through the real reader (scripts/jdCorpus.js) found
  // "communication skills" as a MUST-HAVE on four of nine, plus "attention to detail" and
  // "proactive". Renaissance leaking none of its twelve behavioural competencies was luck
  // we verified once, not a property anything enforced.
  //
  // Deterministic, not a prompt rule: the alias rule added to this same extractor is
  // ignored on 92% of requirements, so the prompt is the cheap first line and this is the
  // one that actually holds.
  describe("behavioural traits", () => {
    const withTraits = {
      requiredSkills: [
        { name: "Communication skills", type: "skill" },
        { name: "Attention to Detail", type: "skill" },
        { name: "proactive", type: "skill" },
        { name: "Permit-to-Work", type: "method" },
      ],
    };

    it("marks a soft trait that cannot be evidenced by describing work", () => {
      const byName = Object.fromEntries(
        roleBriefFromExtraction(withTraits).mustHaves.map((m) => [m.name, m])
      );
      expect(byName["Communication skills"].behavioural).toBe(true);
      expect(byName["Attention to Detail"].behavioural).toBe(true);
      expect(byName.proactive.behavioural).toBe(true);
    });

    it("leaves a real competency unmarked", () => {
      const byName = Object.fromEntries(
        roleBriefFromExtraction(withTraits).mustHaves.map((m) => [m.name, m])
      );
      expect(byName["Permit-to-Work"].behavioural).toBeUndefined();
    });

    // The reason this matches the WHOLE reduced name and never a substring. Both of these
    // are real, evidenceable skills that happen to contain a trait word, and filtering
    // them would delete a requirement the user genuinely needs to prove.
    it("keeps a named professional skill that merely contains a trait word", () => {
      const brief = roleBriefFromExtraction({
        requiredSkills: [
          { name: "Technical Communication", type: "skill" },
          { name: "Stakeholder Management", type: "skill" },
        ],
      });
      expect(brief.mustHaves.every((m) => !m.behavioural)).toBe(true);
    });

    it("sees through the padding a posting wraps a trait in", () => {
      const brief = roleBriefFromExtraction({
        requiredSkills: [
          { name: "Strong Communication" },
          { name: "Excellent interpersonal abilities" },
          { name: "Teamwork mindset" },
        ],
      });
      expect(brief.mustHaves.every((m) => m.behavioural)).toBe(true);
    });

    it("marks nice-to-haves too, and the typed requirements list", () => {
      const brief = roleBriefFromExtraction({
        preferredSkills: [{ name: "Time management", type: "skill" }],
      });
      expect(brief.niceToHaves[0].behavioural).toBe(true);
      expect(brief.requirements[0].behavioural).toBe(true);
    });

    it("keeps them IN the compact arrays — scoring must be untouched", () => {
      // Same contract qualifications hold to. The flag changes what Aria ASKS about, not
      // what anything scores; removing them here would move every fit score.
      expect(roleBriefFromExtraction(withTraits).mustHaves).toHaveLength(4);
    });
  });

  describe("shape and bounds", () => {
    it("composes requirements as must-haves, then nice-to-haves, then responsibilities", () => {
      const { requirements } = roleBriefFromExtraction(EXTRACTION);
      expect(requirements).toHaveLength(4 + 1 + 2);
      expect(requirements.filter((r) => r.type === "responsibility")).toHaveLength(2);
      // Responsibilities exist ONLY here — never as skill chips.
      expect(requirements.at(-1).priority).toBe("must_have");
      expect(
        roleBriefFromExtraction(EXTRACTION).mustHaves.some(
          (m) => m.name === "Collecting field data"
        )
      ).toBe(false);
    });

    it("gives every requirement a stable id derived from its type and name", () => {
      const a = roleBriefFromExtraction(EXTRACTION).requirements;
      const b = roleBriefFromExtraction(EXTRACTION).requirements;
      expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
      expect(a.every((r) => /^req_[0-9a-f]{12}$/.test(r.id))).toBe(true);
    });

    it("forces an unrecognised type to 'skill' rather than trusting the model", () => {
      const brief = roleBriefFromExtraction({
        requiredSkills: [{ name: "Welding", type: "responsibility" }],
      });
      expect(brief.requirements[0].type).toBe("skill");
    });

    it("carries JD aliases onto the compact array — the scorer reads these", () => {
      const brief = roleBriefFromExtraction(EXTRACTION);
      const ptw = brief.mustHaves.find((m) => m.name === "Permit-to-Work");
      expect(ptw.aliases).toEqual(["PTW"]);
    });

    it("caps the lists that ride on every prompt", () => {
      const brief = roleBriefFromExtraction({
        keyResponsibilities: Array.from({ length: 20 }, (_, i) => `Responsibility ${i}`),
        requiredSkills: [
          {
            name: "Thing",
            aliases: Array.from({ length: 20 }, (_, i) => `a${i}`),
            proofSignals: Array.from({ length: 20 }, (_, i) => `p${i}`),
            sourceText: "x".repeat(500),
          },
        ],
      });
      expect(brief.responsibilities).toHaveLength(8);
      expect(brief.requirements[0].aliases).toHaveLength(6);
      expect(brief.requirements[0].proofSignals).toHaveLength(6);
      expect(brief.requirements[0].sourceText).toHaveLength(240);
    });

    it("drops a nameless skill instead of emitting a blank requirement", () => {
      const brief = roleBriefFromExtraction({
        requiredSkills: [{ name: "   " }, { name: "Welding" }],
      });
      expect(brief.mustHaves).toHaveLength(1);
      expect(brief.mustHaves[0].name).toBe("Welding");
    });
  });
});
