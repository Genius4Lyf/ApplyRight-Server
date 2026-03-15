const scoringService = require("../src/services/scoring.service");

describe("Scoring Service", () => {
  describe("calculateFitScore", () => {
    it("should calculate a perfect score when all criteria match", () => {
      const jobAnalysis = {
        skills: [{ name: "React" }, { name: "Node.js" }],
        experience: { minYears: 2 },
        seniority: "mid",
      };
      const resumeProfile = {
        skills: ["React", "Node.js", "TypeScript"],
        experience: [{ years: 3 }],
        seniority: "mid",
      };

      const result = scoringService.calculateFitScore(jobAnalysis, resumeProfile);
      expect(result.fitScore).toBe(100);
      expect(result.fitAnalysis.experienceMatch).toBe(true);
      expect(result.fitAnalysis.seniorityMatch).toBe(true);
    });

    it("should calculate a lower score when skills are missing", () => {
      const jobAnalysis = {
        skills: [{ name: "React" }, { name: "Node.js" }, { name: "AWS" }, { name: "Docker" }],
        experience: { minYears: 2 },
        seniority: "mid",
      };
      const resumeProfile = {
        skills: ["React", "Node.js"],
        experience: [{ years: 2 }],
        seniority: "mid",
      };

      const result = scoringService.calculateFitScore(jobAnalysis, resumeProfile);
      // Skills: 50/100 * 0.5 = 25
      // Exp: 100/100 * 0.3 = 30
      // Seniority: 100/100 * 0.2 = 20
      // Total: 75
      expect(result.fitScore).toBe(75);
      expect(result.fitAnalysis.skillsGap).toContain("AWS");
      expect(result.fitAnalysis.skillsGap).toContain("Docker");
    });

    it("should give a partial score for insufficient experience", () => {
      const jobAnalysis = {
        skills: [{ name: "React" }],
        experience: { minYears: 4 },
        seniority: "senior",
      };
      const resumeProfile = {
        skills: ["React"],
        experience: [{ years: 2 }],
        seniority: "senior",
      };

      const result = scoringService.calculateFitScore(jobAnalysis, resumeProfile);
      // Skills: 100 * 0.5 = 50
      // Exp: (2/4)*100 * 0.3 = 15
      // Seniority: 100 * 0.2 = 20
      // Total: 85
      expect(result.fitScore).toBe(85);
      expect(result.fitAnalysis.experienceMatch).toBe(false);
    });
  });

  describe("generateActionPlan", () => {
    it("should return specific actions for known skills", () => {
      const missingSkills = ["Python", "SQL"];
      const result = scoringService.generateActionPlan(missingSkills);
      
      expect(result).toHaveLength(2);
      expect(result[0].action).toMatch(/Build a script/);
      expect(result[1].action).toMatch(/Practice complex joins/);
    });

    it("should return a generic action for unknown skills", () => {
      const missingSkills = ["Quantum Computing"];
      const result = scoringService.generateActionPlan(missingSkills);
      
      expect(result[0].action).toMatch(/Complete a crash course/);
    });
  });
});
