const {
  reconcileSkillGroups,
  isCertificationLikeSkill,
} = require("../src/services/ai.service");

const detail = (name, refIndex = 0) => ({
  name,
  evidence: [{ type: "experience", refIndex, snippet: `Used ${name} on the job` }],
});

describe("skill category reconciliation", () => {
  it("enforces specific categories, merges singletons, and deduplicates skills", () => {
    const suggestions = [
      {
        category: "Technical Skills",
        skills: ["Electrical Troubleshooting"],
        skillsDetailed: [detail("Electrical Troubleshooting")],
      },
      {
        category: "Professional Skills",
        skills: ["Rigging Preparation", "Wireline Equipment"],
        skillsDetailed: [detail("Rigging Preparation"), detail("Wireline Equipment")],
      },
      {
        category: "Maintenance and Troubleshooting",
        skills: ["Preventive Maintenance", "Equipment Inspection", "Electrical Troubleshooting"],
        skillsDetailed: [
          detail("Preventive Maintenance"),
          detail("Equipment Inspection"),
          detail("Electrical Troubleshooting"),
        ],
      },
    ];
    const assignments = [
      { id: "skill_0", category: "Maintenance Operations" },
      { id: "skill_1", category: "Field Operations" },
      { id: "skill_2", category: "Field Operations" },
      { id: "skill_3", category: "Maintenance Operations" },
      { id: "skill_4", category: "Maintenance Operations" },
      { id: "skill_5", category: "Maintenance Operations" },
    ];

    const result = reconcileSkillGroups(suggestions, assignments, {
      targetRole: "Wireline Field Operator",
    });

    expect(result.map((group) => group.category).sort()).toEqual([
      "Field Operations",
      "Maintenance Operations",
    ]);
    expect(result.every((group) => group.skills.length >= 2)).toBe(true);
    expect(result.flatMap((group) => group.skills)).toEqual(
      expect.arrayContaining([
        "Electrical Troubleshooting",
        "Rigging Preparation",
        "Wireline Equipment",
        "Preventive Maintenance",
        "Equipment Inspection",
      ])
    );
    expect(
      result.flatMap((group) => group.skills).filter((name) => name === "Electrical Troubleshooting")
    ).toHaveLength(1);
  });

  it("rejects credential words, known certifications, and common certification acronyms", () => {
    const suggestions = [
      {
        category: "Safety Operations",
        skills: [
          "NEBOSH",
          "Wireline Safety Certification",
          "Employee Training",
          "Hazard Identification",
        ],
        skillsDetailed: [
          detail("NEBOSH"),
          detail("Wireline Safety Certification"),
          detail("Employee Training"),
          detail("Hazard Identification"),
        ],
      },
    ];

    const result = reconcileSkillGroups(suggestions, [], {
      targetRole: "Wireline Operator",
      knownCertifications: [{ name: "Wireline Safety Certification" }],
    });
    const names = result.flatMap((group) => group.skills);

    expect(names).toEqual(["Employee Training", "Hazard Identification"]);
    expect(isCertificationLikeSkill("PMP", "Project Delivery")).toBe(true);
    expect(isCertificationLikeSkill("Training Facilitation", "People Development")).toBe(false);
  });

  it("does not allow a forbidden fallback heading to survive", () => {
    const suggestions = [
      {
        category: "Professional Skills",
        skills: ["Well Intervention", "Pressure Control"],
        skillsDetailed: [detail("Well Intervention"), detail("Pressure Control")],
      },
    ];

    const result = reconcileSkillGroups(suggestions, [], {
      targetRole: "Wireline Field Operator",
    });

    expect(result[0].category).toBe("Wireline Field Practice");
    expect(result[0].category).not.toBe("Professional Skills");
  });
});
