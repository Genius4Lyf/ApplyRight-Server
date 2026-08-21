const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// Models + ai.service + jwt mocked. subscription.service is intentionally NOT mocked,
// so the REAL availableCredits/spendCredits run against the mocked User/Transaction —
// which is what makes "never charged when the AI throws" a meaningful assertion rather
// than a test of our own stub.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const otherUserId = "60c72b2f9b1d8b2bad6e1a99";
const draftId = "60c72b2f9b1d8b2bad6e1a22";

const JD =
  "We need a backend engineer strong in Python and SQL, deploying data services on AWS at scale.";

const buildDraft = (over = {}) => ({
  _id: draftId,
  userId: { toString: () => mockUserId },
  title: "Ernest CV — Backend Engineer",
  personalInfo: { fullName: "Ernest", email: "e@x.com", phone: "1", linkedin: "in/e" },
  professionalSummary:
    "Backend engineer with six years building data services in Python and SQL on AWS.",
  experience: [
    {
      title: "Engineer",
      company: "Acme",
      startDate: "2019",
      endDate: "2024",
      description: "• Cut latency 40%",
    },
    {
      title: "Junior Engineer",
      company: "Beta",
      startDate: "2017",
      endDate: "2019",
      description: "• Shipped 3 services",
    },
  ],
  projects: [{ title: "Pipeline", description: "• Built an ETL job" }],
  education: [{ degree: "BSc", school: "UNIBEN" }],
  skills: [{ name: "Python" }, { name: "SQL" }],
  targetJob: {
    title: "Backend Engineer",
    description: JD,
    brief: { mustHaves: [{ name: "Python" }, { name: "SQL" }], niceToHaves: [{ name: "AWS" }] },
  },
  studioScan: undefined,
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

const AI_RESULT = {
  fitScore: 82,
  recommendation: "good_match",
  scoreBreakdown: {
    skillsScore: 85,
    experienceScore: 80,
    educationScore: 75,
    seniorityScore: 70,
    overallScore: 88,
  },
  matchedSkills: [{ name: "Python", importance: "must_have" }],
  missingSkills: [{ name: "AWS", importance: "nice_to_have" }],
  evidence: [
    { quote: "Cut latency 40%", issue: "No baseline given", fix: "Say from what to what." },
  ],
};

describe("Aria Studio — scan & recompute", () => {
  let mockUser;
  let draft;

  const setUser = (over = {}) => {
    mockUser = {
      _id: mockUserId,
      id: mockUserId,
      credits: 50,
      save: jest.fn().mockResolvedValue(true),
      ...over,
    };
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(mockUser) });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setUser();
    jwt.verify.mockReturnValue({ id: mockUserId });
    // The atomic credit decrement path used by subscription.spendCredits.
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Transaction.create.mockResolvedValue({});
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    aiService.analyzeProfile.mockResolvedValue(AI_RESULT);
    aiService.resolveTextModel.mockReturnValue("gpt-4o-mini");
    draft = buildDraft();
    DraftCV.findById.mockResolvedValue(draft);
  });

  const post = (path, body = {}) =>
    request(app)
      .post(`/api/studio/${path}`)
      .set("Authorization", "Bearer token")
      .send({ draftId, ...body });

  describe("POST /api/studio/scan", () => {
    it("returns a real score plus deterministic section bands, and persists the snapshot", async () => {
      const res = await post("scan");

      expect(res.statusCode).toBe(200);
      expect(res.body.studioScan.fitScore).toBe(82);
      expect(res.body.studioScan.recommendation).toBe("good_match");
      expect(res.body.studioScan.evidence).toHaveLength(1);

      // Sections came from the free deterministic scan, not the AI.
      const sections = res.body.studioScan.sections;
      expect(sections).toHaveLength(6);
      sections.forEach((s) => expect(["ok", "warn", "bad"]).toContain(s.band));
      expect(sections.find((s) => s.key === "skills")).toBeDefined();

      expect(res.body.studioScan.jdHash).toEqual(expect.any(String));
      expect(res.body.studioScan.scannedAt).toBeDefined();
      // NARROW PATCH, not a full-document save: only studioScan is written back, so a
      // slow (AI-bound) scan can't revert an edit the client saved while it ran.
      expect(draft.save).not.toHaveBeenCalled();
      expect(DraftCV.updateOne).toHaveBeenCalledWith(
        { _id: draft._id },
        { $set: expect.objectContaining({ studioScan: expect.any(Object) }) }
      );
      const [, update] = DraftCV.updateOne.mock.calls[0];
      expect(update.$set.studioScan.fitScore).toBe(82);
      expect(update.$set.studioScan.rulesVersion).toEqual(expect.any(Number));
    });

    it("charges ANALYSIS exactly once, AFTER the AI succeeds", async () => {
      const res = await post("scan");

      expect(res.statusCode).toBe(200);
      expect(User.updateOne).toHaveBeenCalledTimes(1);
      // 10 credits (COSTS.ANALYSIS) came off the wallet.
      const [, update] = User.updateOne.mock.calls[0];
      expect(update.$inc.credits).toBe(-10);
      expect(res.body.remainingCredits).toBe(40);
    });

    it("does NOT deduct credits when analyzeProfile throws", async () => {
      aiService.analyzeProfile.mockRejectedValue(new Error("model exploded"));

      const res = await post("scan");

      expect(res.statusCode).toBe(502);
      expect(User.updateOne).not.toHaveBeenCalled();
      expect(Transaction.create).not.toHaveBeenCalled();
      expect(draft.save).not.toHaveBeenCalled(); // no half-written snapshot either
    });

    it("does NOT deduct credits when the AI is unavailable", async () => {
      class AIUnavailableError extends Error {}
      aiService.AIUnavailableError = AIUnavailableError;
      aiService.analyzeProfile.mockRejectedValue(new AIUnavailableError("no key"));

      const res = await post("scan");

      expect(res.statusCode).toBe(503);
      expect(User.updateOne).not.toHaveBeenCalled();
    });

    it("refuses before calling the AI when the balance is short", async () => {
      setUser({ credits: 3 });

      const res = await post("scan");

      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
      expect(aiService.analyzeProfile).not.toHaveBeenCalled();
      expect(User.updateOne).not.toHaveBeenCalled();
    });

    it("400s a CV with no target job", async () => {
      DraftCV.findById.mockResolvedValue(
        buildDraft({ targetJob: { title: "X", description: "" } })
      );

      const res = await post("scan");

      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe("NO_TARGET_JOB");
      expect(aiService.analyzeProfile).not.toHaveBeenCalled();
    });

    it("captures a baseline on the FIRST scan", async () => {
      const res = await post("scan");

      expect(res.body.studioScan.baseline.fitScore).toBe(82);
      expect(res.body.studioScan.baseline.sections).toHaveLength(6);
      expect(res.body.studioScan.baseline.capturedAt).toBeDefined();
    });

    it("NEVER overwrites an existing baseline on a re-scan", async () => {
      // The user started at 40, improved, and re-checks. "Before" must stay 40 —
      // resetting it to the improved score would erase the progress it exists to show.
      const improved = buildDraft({
        studioScan: {
          baseline: { fitScore: 40, sections: [{ key: "skills", band: "bad", score: 10 }] },
          toObject() {
            const { toObject, ...rest } = this;
            return rest;
          },
        },
      });
      DraftCV.findById.mockResolvedValue(improved);

      const res = await post("scan");

      expect(res.body.studioScan.fitScore).toBe(82); // current moved
      expect(res.body.studioScan.baseline.fitScore).toBe(40); // origin did not
    });

    it("rejects a draft owned by someone else", async () => {
      DraftCV.findById.mockResolvedValue(buildDraft({ userId: { toString: () => otherUserId } }));

      const res = await post("scan");

      expect(res.statusCode).toBe(403);
      expect(aiService.analyzeProfile).not.toHaveBeenCalled();
    });

    it("404s a missing draft and 400s a malformed id", async () => {
      DraftCV.findById.mockResolvedValue(null);
      expect((await post("scan")).statusCode).toBe(404);

      expect((await post("scan", { draftId: "nope" })).statusCode).toBe(400);
    });
  });

  describe("POST /api/studio/recompute", () => {
    const scanned = () =>
      buildDraft({
        studioScan: {
          fitScore: 82,
          recommendation: "good_match",
          evidence: [{ quote: "Cut latency 40%", issue: "No baseline", fix: "Add one." }],
          sections: [],
          scannedAt: new Date("2026-07-01"),
          toObject() {
            const { toObject, ...rest } = this;
            return rest;
          },
        },
      });

    it("charges nothing and never calls the AI", async () => {
      DraftCV.findById.mockResolvedValue(scanned());

      const res = await post("recompute");

      expect(res.statusCode).toBe(200);
      expect(aiService.analyzeProfile).not.toHaveBeenCalled();
      expect(aiService.resolveTextModel).not.toHaveBeenCalled();
      expect(User.updateOne).not.toHaveBeenCalled();
      expect(Transaction.create).not.toHaveBeenCalled();
    });

    it("refreshes scores and bands deterministically", async () => {
      const d = scanned();
      DraftCV.findById.mockResolvedValue(d);

      const res = await post("recompute");

      expect(res.body.studioScan.sections).toHaveLength(6);
      expect(res.body.studioScan.fitScore).toEqual(expect.any(Number));
      expect(res.body.studioScan.scoreBreakdown.skillsScore).toEqual(expect.any(Number));
      expect(res.body.studioScan.recomputedAt).toBeDefined();
      // Same narrow patch as scan(). Recompute fires right after an edit save, so a
      // full-document write here is the likelier of the two to clobber that edit.
      expect(d.save).not.toHaveBeenCalled();
      expect(DraftCV.updateOne).toHaveBeenCalledWith(
        { _id: d._id },
        { $set: expect.objectContaining({ studioScan: expect.any(Object) }) }
      );
    });

    it("keeps the last AI narrative verbatim and flags it fromLastFullScan", async () => {
      DraftCV.findById.mockResolvedValue(scanned());

      const res = await post("recompute");

      expect(res.body.studioScan.evidence).toEqual([
        { quote: "Cut latency 40%", issue: "No baseline", fix: "Add one." },
      ]);
      expect(res.body.studioScan.fromLastFullScan).toBe(true);
    });

    it("carries the baseline through untouched — a free re-score is not a new start", async () => {
      const d = buildDraft({
        studioScan: {
          fitScore: 82,
          baseline: { fitScore: 40, sections: [] },
          scannedAt: new Date("2026-07-01"),
          toObject() {
            const { toObject, ...rest } = this;
            return rest;
          },
        },
      });
      DraftCV.findById.mockResolvedValue(d);

      const res = await post("recompute");

      expect(res.body.studioScan.baseline.fitScore).toBe(40);
    });

    it("does not claim fromLastFullScan when there was never a full scan", async () => {
      DraftCV.findById.mockResolvedValue(buildDraft()); // studioScan undefined

      const res = await post("recompute");

      expect(res.statusCode).toBe(200);
      expect(res.body.studioScan.fromLastFullScan).toBe(false);
      expect(res.body.studioScan.evidence).toEqual([]);
    });

    it("reflects an edit — adding the missing skill moves its section band up", async () => {
      const before = await post("recompute");
      const beforeSkills = before.body.studioScan.sections.find((s) => s.key === "skills");

      DraftCV.findById.mockResolvedValue(
        buildDraft({
          skills: [
            { name: "Python" },
            { name: "SQL" },
            { name: "AWS" },
            { name: "Docker" },
            { name: "Terraform" },
            { name: "Kafka" },
            { name: "Redis" },
            { name: "Go" },
          ],
        })
      );
      const after = await post("recompute");
      const afterSkills = after.body.studioScan.sections.find((s) => s.key === "skills");

      expect(afterSkills.score).toBeGreaterThan(beforeSkills.score);
      expect(afterSkills.missingKeywords).not.toContain("AWS");
      expect(aiService.analyzeProfile).not.toHaveBeenCalled();
    });

    it("400s a CV with no target job", async () => {
      DraftCV.findById.mockResolvedValue(
        buildDraft({ targetJob: { title: "X", description: "" } })
      );
      const res = await post("recompute");
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe("NO_TARGET_JOB");
    });

    it("rejects a draft owned by someone else", async () => {
      DraftCV.findById.mockResolvedValue(buildDraft({ userId: { toString: () => otherUserId } }));
      expect((await post("recompute")).statusCode).toBe(403);
    });
  });
});

