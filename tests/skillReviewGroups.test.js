const { skillReviewGroups } = require("../src/controllers/ai.controller");

const suggestions = [
  {
    category: "Operations",
    skills: ["Wireline Equipment", "Rigging Preparation", "Report Writing"],
    skillsDetailed: [
      {
        name: "Wireline Equipment",
        evidence: [{ type: "experience", refIndex: 0, snippet: "Prepared wireline equipment" }],
      },
      {
        name: "Rigging Preparation",
        evidence: [{ type: "experience", refIndex: 0, snippet: "Prepared rigging tools" }],
      },
      {
        name: "Report Writing",
        evidence: [{ type: "project", refIndex: 0, snippet: "Wrote a technical report" }],
      },
    ],
  },
];

const profile = {
  education: [],
  experience: [
    {
      title: "Wireline Field Operator",
      company: "SLB",
      description: "Prepared rigging tools and weekly operational reports at the rig.",
    },
  ],
  projects: [{ title: "Field Report", description: "Wrote a technical report." }],
};

describe("skillReviewGroups", () => {
  it("uses Core skills instead of role ranking when there is no JD", () => {
    const groups = skillReviewGroups({
      suggestions,
      bestForRole: [],
      roleBrief: null,
      targetJob: "",
      confirmationCandidates: [
        {
          name: "Microsoft Excel",
          category: "Tools & Software",
          reason: "Weekly reporting makes this reasonable to confirm.",
          evidence: [{ type: "experience", refIndex: 0, snippet: "Prepared weekly reports" }],
        },
      ],
      ...profile,
    });

    expect(groups.mode).toBe("profile");
    expect(groups.core.map((row) => row.name)).toEqual([
      "Wireline Equipment",
      "Rigging Preparation",
      "Report Writing",
    ]);
    expect(groups.confirmation[0]).toMatchObject({
      name: "Microsoft Excel",
      evidenceStatus: "plausible",
    });
    expect(groups.confirmation[0].evidence[0].sourceLabel).toBe("Wireline Field Operator at SLB");
    expect(groups.gaps).toEqual([]);
  });

  it("separates proven matches and plausible confirmations without treating certifications as skills", () => {
    const groups = skillReviewGroups({
      suggestions,
      bestForRole: ["Wireline Equipment"],
      targetJob: "Wireline role requiring Excel and a safety certificate.",
      roleBrief: {
        role: "Wireline Operator",
        requirements: [
          {
            id: "req_wireline",
            name: "Wireline Equipment",
            type: "domain",
            priority: "must_have",
          },
          {
            id: "req_excel",
            name: "Microsoft Excel",
            type: "tool",
            priority: "must_have",
            aliases: ["Excel"],
            proofSignals: ["weekly reports"],
          },
          {
            id: "req_cert",
            name: "Wireline Safety Certification",
            type: "certification",
            priority: "nice_to_have",
            proofSignals: ["safety certification"],
          },
        ],
      },
      ...profile,
    });

    expect(groups.mode).toBe("job");
    expect(groups.important.map((row) => row.name)).toEqual(["Wireline Equipment"]);
    expect(groups.additional.map((row) => row.name)).toEqual([
      "Rigging Preparation",
      "Report Writing",
    ]);
    expect(groups.confirmation.map((row) => row.name)).toEqual(["Microsoft Excel"]);
    expect(groups.gaps).toEqual([
      expect.objectContaining({
        name: "Wireline Safety Certification",
        requirementKind: "certification",
        evidenceStatus: "not_demonstrated",
      }),
    ]);
    expect(groups.confirmation.map((row) => row.name)).not.toContain(
      "Wireline Safety Certification"
    );
  });
});
