// Money-correctness tests for analysis.controller.js — the app's biggest AI-charging
// surface (CV generation, cover letters, interview prep, bundle pricing). This file is
// intentionally NOT exhaustive; it covers the one invariant that matters for revenue:
// charge only after AI work succeeds, never on failure, and never more than once.
//
// Convention (see tests/billing.payment.test.js, tests/studioScan.test.js): models +
// ai.service + jwt are mocked; subscription.service is left REAL so availableCredits/
// spendCredits run against the mocked User/Transaction — that's what makes "never
// charged when the AI throws" a meaningful assertion rather than a test of our own stub.
// SystemSettings is auto-mocked with no explicit getInstance() implementation, so it
// resolves to `undefined` and settings.getCreditCosts() falls through to the real
// DEFAULT_CREDIT_COSTS — exactly like a fresh deploy with no admin overrides.
const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Job = require("../src/models/Job");
const Resume = require("../src/models/Resume");
const DraftCV = require("../src/models/DraftCV");
const Application = require("../src/models/Application");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/Job");
jest.mock("../src/models/Resume");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Application");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

// Sourced from the same place the controller resolves costs from (settingsService →
// config/creditCosts.js defaults), so these assertions can't silently go stale if a
// price changes — a bumped ANALYSIS or GENERATE_BUNDLE cost updates this too.
const COSTS = require("../src/config/creditCosts").getDefaults();

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const jobId = "60c72b2f9b1d8b2bad6e1a22";
const resumeId = "60c72b2f9b1d8b2bad6e1a33";
const appId = "60c72b2f9b1d8b2bad6e1a44";

// Poll a real (non-fake-timer) condition. Needed because generate-bundle responds 202
// and runs its 3-stage pipeline in a detached fire-and-forget IIFE — there's no promise
// the test can await, so we wait for an observable side effect instead.
const waitFor = async (predicate, { timeout = 2000, interval = 5 } = {}) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

const setUserCredits = (credits) => {
  const mockUser = { _id: mockUserId, id: mockUserId, credits };
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue(mockUser),
    then: (resolve) => resolve(mockUser),
  });
  return mockUser;
};

describe("analysis.controller — money correctness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: mockUserId });
    setUserCredits(50);
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Transaction.create.mockResolvedValue({});
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    aiService.resolveTextModel.mockReturnValue("gpt-4o-mini");
  });

  describe("POST /api/analysis/analyze — with jobId (ANALYSIS rate)", () => {
    const AI_RESULT = {
      fitScore: 75,
      overallFeedback: "Good fit overall.",
      recommendation: "good_match",
      mode: "standard",
      evidence: [],
      matchedSkills: ["Python"],
      missingSkills: [],
      experienceAnalysis: { candidateYears: 3, requiredYears: 2, match: true, feedback: "ok" },
      seniorityAnalysis: { candidateLevel: "mid", requiredLevel: "mid", match: true, feedback: "ok" },
      scoreBreakdown: {
        skillsScore: 80, experienceScore: 75, educationScore: 70, seniorityScore: 75, overallScore: 75,
      },
      actionPlan: [{ action: "Highlight Python experience" }],
    };

    beforeEach(() => {
      Job.findById.mockResolvedValue({
        _id: jobId,
        title: "Backend Engineer",
        company: "Acme",
        description: "Backend role needing Python.",
        save: jest.fn().mockResolvedValue(true),
      });
      Resume.findById.mockResolvedValue({ _id: resumeId, rawText: "Resume text with Python experience." });
      Application.findOne.mockResolvedValue({
        _id: appId,
        userId: mockUserId,
        jobId,
        resumeId,
        fitScore: null,
        fitAnalysis: null,
        actionPlan: [],
        save: jest.fn().mockResolvedValue(true),
      });
      aiService.analyzeProfile.mockResolvedValue(AI_RESULT);
    });

    const post = (body = {}) =>
      request(app)
        .post("/api/analysis/analyze")
        .set("Authorization", "Bearer token")
        .send({ jobId, resumeId, ...body });

    it("charges ANALYSIS exactly once AFTER the AI succeeds, and returns the analysis", async () => {
      const res = await post();

      expect(res.statusCode).toBe(200);
      expect(res.body.fitScore).toBe(75);
      expect(res.body.fitAnalysis).toBeDefined();
      expect(res.body.fitAnalysis.recommendation).toBe("good_match");
      expect(res.body.actionPlan).toEqual(AI_RESULT.actionPlan);

      expect(User.updateOne).toHaveBeenCalledTimes(1);
      const [, update] = User.updateOne.mock.calls[0];
      expect(update.$inc.credits).toBe(-COSTS.ANALYSIS);
    });

    it("does NOT charge when the AI is unavailable — 503 says not charged", async () => {
      const err = new Error("no key configured");
      err.code = "AI_UNAVAILABLE";
      aiService.analyzeProfile.mockRejectedValue(err);

      const res = await post();

      expect(res.statusCode).toBe(503);
      expect(res.body.message).toMatch(/you have not been charged/i);
      expect(User.updateOne).not.toHaveBeenCalled();
      expect(Transaction.create).not.toHaveBeenCalled();
    });

    it("refuses before calling the AI when combined credits are short (403 INSUFFICIENT_CREDITS)", async () => {
      setUserCredits(3); // below COSTS.ANALYSIS (10)

      const res = await post();

      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
      expect(aiService.analyzeProfile).not.toHaveBeenCalled();
      expect(User.updateOne).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/analysis/analyze — without jobId (CREATE_FROM_UPLOAD rate)", () => {
    beforeEach(() => {
      Resume.findById.mockResolvedValue({ _id: resumeId, rawText: "Resume text with Python experience." });
      aiService.extractResumeProfile.mockResolvedValue({
        summary: "Backend engineer.",
        experience: [],
        education: [],
        projects: [],
        skills: [],
        contactInfo: {},
      });
      aiService.generateStructuredSkills.mockResolvedValue([]);
      DraftCV.create.mockResolvedValue({ _id: "draft1" });
    });

    const post = (body = {}) =>
      request(app)
        .post("/api/analysis/analyze")
        .set("Authorization", "Bearer token")
        .send({ resumeId, ...body }); // no jobId

    it("charges the UPLOAD-ONLY rate (15), not the with-job rate (10), after the AI succeeds", async () => {
      const res = await post();

      expect(res.statusCode).toBe(200);
      expect(res.body.draftId).toBe("draft1");

      expect(User.updateOne).toHaveBeenCalledTimes(1);
      const [, update] = User.updateOne.mock.calls[0];
      expect(update.$inc.credits).toBe(-COSTS.CREATE_FROM_UPLOAD);
      expect(COSTS.CREATE_FROM_UPLOAD).not.toBe(COSTS.ANALYSIS); // sanity: rates actually differ
    });

    it("does NOT charge when the AI is unavailable", async () => {
      const err = new Error("no key configured");
      err.code = "AI_UNAVAILABLE";
      aiService.extractResumeProfile.mockRejectedValue(err);

      const res = await post();

      expect(res.statusCode).toBe(503);
      expect(res.body.message).toMatch(/you have not been charged/i);
      expect(User.updateOne).not.toHaveBeenCalled();
    });

    it("refuses on the UPLOAD-ONLY threshold — enough for ANALYSIS but not for CREATE_FROM_UPLOAD", async () => {
      // 12 is >= COSTS.ANALYSIS (10) but < COSTS.CREATE_FROM_UPLOAD (15). If the
      // handler mistakenly checked the with-job rate, this would incorrectly pass.
      setUserCredits(12);

      const res = await post();

      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
      expect(res.body.required).toBe(COSTS.CREATE_FROM_UPLOAD);
      expect(aiService.extractResumeProfile).not.toHaveBeenCalled();
      expect(User.updateOne).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/analysis/:id/generate-bundle — all-or-nothing charging", () => {
    let consoleErrorSpy;

    beforeEach(() => {
      consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      Application.findOne.mockResolvedValue({
        _id: appId,
        userId: mockUserId,
        resumeId,
        jobId,
        generationStatus: undefined,
        toObject() {
          const { toObject, save, ...rest } = this;
          return rest;
        },
        save: jest.fn().mockResolvedValue(true),
      });
      // Each internal re-fetch (the CV pipeline's `fresh`, then the bundle's
      // post-charge `finalApp`) gets its own fresh mutable object + save spy.
      Application.findById.mockImplementation(async () => ({
        _id: appId,
        save: jest.fn().mockResolvedValue(true),
      }));
      Application.updateOne.mockResolvedValue({});

      Resume.findById.mockResolvedValue({ _id: resumeId, rawText: "Resume text with Python experience." });
      Job.findById.mockResolvedValue({
        _id: jobId,
        title: "Backend Engineer",
        company: "Acme",
        description: "Backend role needing Python.",
      });

      // CV stage
      aiService.extractCandidateData.mockResolvedValue({
        summary: "Backend engineer.",
        experience: [{ role: "Engineer", company: "Acme", description: "Built things." }],
        education: [],
        projects: [],
        skills: ["Python"],
      });
      aiService.extractJobRequirements.mockResolvedValue({
        requiredSkills: [],
        preferredSkills: [],
        detectedJobTitle: "Backend Engineer",
        detectedCompany: "Acme",
      });
      aiService.enhanceCVContent.mockResolvedValue({
        professionalSummary: "Enhanced summary.",
        experience: [{ title: "Engineer", company: "Acme", bullets: ["Did X"] }],
        projects: [],
        skills: ["Python"],
      });
      aiService.categorizeSkillsList.mockResolvedValue([{ name: "Python", category: "Technical" }]);
      DraftCV.create.mockResolvedValue({ _id: "draft1" });
      // Groundable experience so the bundle's interview stage actually runs.
      DraftCV.findById.mockResolvedValue({
        professionalSummary: "Enhanced summary.",
        experience: [{ title: "Engineer", company: "Acme", description: "Built things." }],
        education: [],
        projects: [],
        skills: [{ name: "Python" }],
      });

      // Cover letter stage
      aiService.generateCoverLetter.mockResolvedValue("Dear hiring manager...");
      aiService.factCheckCoverLetter.mockResolvedValue([]);

      // Interview prep stage
      aiService.generateInterviewQuestions.mockResolvedValue({
        jobQuestions: [{ question: "Tell me about a time you..." }],
        questionsToAsk: ["What does success look like in 90 days?"],
      });
      aiService.factCheckInterviewQuestions.mockResolvedValue([]);
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    const postBundle = () =>
      request(app)
        .post(`/api/analysis/${appId}/generate-bundle`)
        .set("Authorization", "Bearer token")
        .send({});

    it("charges GENERATE_BUNDLE exactly once — not three times, not the sum of individual rates", async () => {
      const res = await postBundle();
      expect(res.statusCode).toBe(202);

      await waitFor(() => User.updateOne.mock.calls.length > 0);

      expect(User.updateOne).toHaveBeenCalledTimes(1);
      const [, update] = User.updateOne.mock.calls[0];
      expect(update.$inc.credits).toBe(-COSTS.GENERATE_BUNDLE);
      // Sanity: the bundle rate is a discount, not the sum of the three individual rates.
      const sumOfIndividualRates =
        COSTS.GENERATE_CV + COSTS.GENERATE_COVER_LETTER + COSTS.GENERATE_INTERVIEW;
      expect(COSTS.GENERATE_BUNDLE).toBeLessThan(sumOfIndividualRates);
    });

    it("does not charge until the CV stage (chargeOnSuccess:false) AND the interview stage have both resolved", async () => {
      let chargedBeforeCvStageDone = null;
      let chargedBeforeInterviewStageDone = null;

      DraftCV.create.mockImplementation(async (doc) => {
        // The CV stage runs with chargeOnSuccess:false — by the time it persists
        // its own draft, the bundle-level charge must not have happened yet.
        chargedBeforeCvStageDone = User.updateOne.mock.calls.length > 0;
        return { _id: "draft1", ...doc };
      });
      aiService.generateInterviewQuestions.mockImplementation(async () => {
        chargedBeforeInterviewStageDone = User.updateOne.mock.calls.length > 0;
        return {
          jobQuestions: [{ question: "Tell me about a time you..." }],
          questionsToAsk: ["What does success look like in 90 days?"],
        };
      });

      const res = await postBundle();
      expect(res.statusCode).toBe(202);

      await waitFor(() => User.updateOne.mock.calls.length > 0);

      expect(chargedBeforeCvStageDone).toBe(false);
      expect(chargedBeforeInterviewStageDone).toBe(false);
      expect(User.updateOne).toHaveBeenCalledTimes(1);
    });

    it("never charges when one stage fails (interview-prep AI throws) — the application is never touched again either", async () => {
      aiService.generateInterviewQuestions.mockRejectedValue(new Error("interview AI exploded"));

      const res = await postBundle();
      // The 202 is sent BEFORE any stage runs (fire-and-forget), so it can't itself
      // report the eventual failure — we wait for the pipeline's own failure log
      // instead, which is the real signal that the attempt is over.
      expect(res.statusCode).toBe(202);

      await waitFor(() =>
        consoleErrorSpy.mock.calls.some((call) => call[0] === "[Bundle] Pipeline failed:")
      );

      expect(User.updateOne).not.toHaveBeenCalled();
      expect(Transaction.create).not.toHaveBeenCalled();
      // Only the CV pipeline's own internal re-fetch happened; the bundle's
      // post-charge `finalApp` fetch (which only runs after a successful charge)
      // never fires — proof no artifacts were committed for the failed attempt.
      expect(Application.findById).toHaveBeenCalledTimes(1);
    });
  });
});
