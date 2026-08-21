const {
  targetRequirementsForEntry,
  selectRequiredRequirementProbe,
  verifiedInterviewEvidence,
  verifiedRequirementChecks,
} = require("../src/controllers/coach.controller");
const DraftCV = require("../src/models/DraftCV");

const draft = {
  experience: [],
  projects: [],
  skills: [],
  professionalSummary: "",
};

const brief = {
  mustHaves: [
    { name: "Microsoft Excel", importance: "must_have" },
    { name: "Customer Service", importance: "must_have" },
    { name: "Power BI", importance: "must_have" },
    { name: "Inventory Management", importance: "must_have" },
  ],
  requirements: [
    {
      id: "req_excel",
      name: "Microsoft Excel",
      type: "tool",
      aliases: ["Excel"],
      proofSignals: ["weekly reports", "spreadsheets", "pivot tables"],
    },
    {
      id: "req_customer",
      name: "Customer Service",
      type: "skill",
      aliases: [],
      proofSignals: ["customers", "complaints"],
    },
    {
      id: "req_powerbi",
      name: "Power BI",
      type: "tool",
      aliases: [],
      proofSignals: ["dashboard", "visualisation"],
    },
    {
      id: "req_inventory",
      name: "Inventory Management",
      type: "method",
      aliases: ["stock control"],
      proofSignals: ["stock", "shortages", "replenishment"],
    },
  ],
};

describe("JD-guided role interview evidence", () => {
  it("stores typed Role Brief requirements as objects", () => {
    const candidate = new DraftCV({
      user: "507f1f77bcf86cd799439011",
      title: "Wireline CV",
      targetJob: {
        brief: {
          requirements: [
            {
              id: "req_wireline",
              name: "Wireline equipment",
              type: "domain",
              priority: "must_have",
              aliases: [],
              proofSignals: ["logging operations"],
            },
          ],
        },
      },
    });

    const validationError = candidate.validateSync();

    expect(validationError?.errors?.["targetJob.brief.requirements.0"]).toBeUndefined();
    expect(candidate.targetJob.brief.requirements[0]).toMatchObject({
      id: "req_wireline",
      name: "Wireline equipment",
      type: "domain",
      priority: "must_have",
    });
  });

  it("ranks requirements whose evidence signals occur in this role conversation", () => {
    const result = targetRequirementsForEntry(
      draft,
      brief,
      { title: "Retail Assistant", company: "Corner Shop", entryType: "partTime" },
      [{ who: "user", text: "I helped customers, checked stock and prepared weekly reports." }],
      3
    );

    expect(result).toHaveLength(3);
    expect(result.map((item) => item.name)).toEqual([
      "Inventory Management",
      "Microsoft Excel",
      "Customer Service",
    ]);
    expect(result[0]).toMatchObject({ id: "req_inventory", type: "method" });
  });

  it("requires one visible JD probe after the opening activity, without back-to-back checks", () => {
    const requirements = targetRequirementsForEntry(
      draft,
      brief,
      { title: "Retail Assistant", entryType: "partTime" },
      [{ who: "user", text: "I checked stock and prepared weekly reports." }],
      3
    );

    expect(
      selectRequiredRequirementProbe(
        requirements,
        [
          { who: "aria", text: "Tell me what you handled." },
          { who: "user", text: "I checked stock and prepared weekly reports." },
        ],
        1
      )
    ).toBeNull();

    const selected = selectRequiredRequirementProbe(
      requirements,
      [
        { who: "aria", text: "Tell me what you handled." },
        { who: "user", text: "I checked stock and prepared weekly reports." },
      ],
      2
    );
    expect(selected?.name).toBe("Inventory Management");

    expect(
      selectRequiredRequirementProbe(
        requirements,
        [
          { who: "aria", text: "The job description mentions Inventory Management." },
          { who: "user", text: "No, I only counted the items." },
        ],
        3
      )
    ).toBeNull();
  });

  it("accepts evidence only when sourceQuote is copied from a real user turn", () => {
    const turns = [
      { who: "aria", text: "What did you use for the reports?" },
      { who: "user", text: "I used Google Sheets to prepare the weekly sales reports." },
    ];
    const evidence = verifiedInterviewEvidence(
      [
        {
          claim: "I prepared weekly reports in Google Sheets.",
          sourceQuote: "I used Google Sheets to prepare the weekly sales reports.",
          tools: ["Google Sheets"],
          requirementIds: ["req_excel"],
        },
        {
          claim: "I used Excel pivot tables.",
          sourceQuote: "I used Excel pivot tables.",
          tools: ["Microsoft Excel"],
          requirementIds: ["req_excel"],
        },
      ],
      turns,
      brief.requirements
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      tools: ["Google Sheets"],
      sourceQuote: "I used Google Sheets to prepare the weekly sales reports.",
      requirementIds: [],
    });
  });

  it("does not allow a positive requirement check without verified evidence", () => {
    const checks = verifiedRequirementChecks(
      [
        { requirementId: "req_excel", status: "confirmed", evidenceIndex: null },
        { requirementId: "req_powerbi", status: "not_applicable", evidenceIndex: null },
      ],
      brief.requirements,
      []
    );

    expect(checks).toEqual([
      {
        requirementId: "req_powerbi",
        name: "Power BI",
        status: "not_applicable",
        evidenceId: null,
        note: "",
      },
    ]);
  });

  it("links a confirmed check to the cited evidence index", () => {
    const evidence = verifiedInterviewEvidence(
      [
        {
          claim: "I used Excel for stock reports.",
          sourceQuote: "I used Excel for stock reports.",
          tools: ["Microsoft Excel"],
          requirementIds: ["req_excel"],
        },
      ],
      [{ who: "user", text: "I used Excel for stock reports." }],
      brief.requirements
    );
    const checks = verifiedRequirementChecks(
      [{ requirementId: "req_excel", status: "confirmed", evidenceIndex: 0 }],
      brief.requirements,
      evidence
    );

    expect(checks[0]).toMatchObject({
      requirementId: "req_excel",
      status: "confirmed",
      evidenceId: evidence[0].id,
    });
  });
});
