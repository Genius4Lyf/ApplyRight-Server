const request = require("supertest");
const app = require("../src/app");
const Application = require("../src/models/Application");
const User = require("../src/models/User");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const analysisController = require("../src/controllers/analysis.controller");
const jwt = require("jsonwebtoken");

// Mock Models & Services
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/Application");
jest.mock("../src/models/User");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

// Mock Data
const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const mockAppId = "60c72b2f9b1d8b2bad6e1a22";

const mockUser = {
  _id: mockUserId,
  id: mockUserId, // Mock the virtual id getter
  email: "candidate@example.com",
  credits: 10,
  updateOne: jest.fn().mockResolvedValue(true),
};

const mockApplication = {
  _id: mockAppId,
  userId: mockUserId,
  jobTitle: "Software Developer",
  jobCompany: "Acme Corp",
  interviewPrep: {
    jobQuestions: [
      {
        question: "Tell me about React hooks.",
        suggestedAnswer: "React hooks allow functional components to use state...",
        type: "technical",
      },
    ],
  },
  save: jest.fn().mockResolvedValue(true),
  markModified: jest.fn(),
};

describe("Interview Prep API", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock JWT Auth
    jwt.verify.mockReturnValue({ id: mockUserId });
    const userQuery = {
      select: jest.fn().mockResolvedValue(mockUser),
      then: jest.fn().mockImplementation(function(resolve) {
        return resolve(mockUser);
      }),
    };
    User.findById.mockReturnValue(userQuery);

    // Atomic credit deduction: the controller guards the balance inside a
    // static updateOne. Default to a successful decrement (modifiedCount: 1).
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    // Mock SystemSettings for maintenance check (prevents DB buffer timeout)
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });

    // Mock Application DB operations with chaining
    const appQuery = {
      select: jest.fn().mockImplementation(function() {
        return Promise.resolve(mockApplication);
      }),
      populate: jest.fn().mockImplementation(function() {
        return this;
      }),
      lean: jest.fn().mockImplementation(function() {
        return Promise.resolve(mockApplication);
      }),
      then: jest.fn().mockImplementation(function(resolve) {
        return resolve(mockApplication);
      }),
    };
    Application.findById.mockReturnValue(appQuery);

    // Spy and mock buildInterviewCandidateContext
    jest.spyOn(analysisController, "buildInterviewCandidateContext").mockResolvedValue({
      summary: "Mock candidate profile summary",
      experience: [],
    });
  });

  describe("PATCH /api/interview-prep/:applicationId/question-confidence", () => {
    it("should update question confidence successfully", async () => {
      const res = await request(app)
        .patch(`/api/interview-prep/${mockAppId}/question-confidence`)
        .set("Authorization", "Bearer mock-token")
        .send({
          questionText: "Tell me about React hooks.",
          questionIndex: 0,
          confidence: "ready",
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body.status).toBe("ok");
      expect(mockApplication.interviewPrep.jobQuestions[0].confidence).toBe("ready");
      expect(mockApplication.save).toHaveBeenCalled();
    });

    it("should return 400 for invalid confidence level", async () => {
      const res = await request(app)
        .patch(`/api/interview-prep/${mockAppId}/question-confidence`)
        .set("Authorization", "Bearer mock-token")
        .send({
          questionText: "Tell me about React hooks.",
          questionIndex: 0,
          confidence: "invalid-level",
        });

      expect(res.statusCode).toEqual(400);
    });
  });

  describe("POST /api/interview-prep/:applicationId/grade-answer", () => {
    it("should grade answer and deduct 1 credit successfully", async () => {
      const mockAIResult = {
        score: 85,
        overallFeedback: "Good response, check STAR actions.",
        starBreakdown: {
          situation: { covered: true, feedback: "Good situation context." },
          task: { covered: true, feedback: "Covered task." },
          action: { covered: true, feedback: "Action covered." },
          result: { covered: false, feedback: "No key metrics." },
        },
        refinedAnswer: "Polished candidate response...",
      };

      aiService.gradeInterviewAnswer.mockResolvedValue(mockAIResult);

      const res = await request(app)
        .post(`/api/interview-prep/${mockAppId}/grade-answer`)
        .set("Authorization", "Bearer mock-token")
        .send({
          questionText: "Tell me about React hooks.",
          questionIndex: 0,
          answerText: "I used React hooks like useState and useEffect to manage state in application...",
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body.score).toEqual(85);
      expect(res.body.confidence).toEqual("ready"); // Auto confidence based on score > 75
      // Attempt history: the graded answer is recorded on the question and
      // returned so the UI can show the trend without a reload.
      expect(Array.isArray(res.body.attempts)).toBe(true);
      expect(res.body.attempts[res.body.attempts.length - 1].score).toEqual(85);
      expect(mockApplication.interviewPrep.jobQuestions[0].attempts.length).toBeGreaterThan(0);
      // Credit deducted atomically via a balance-guarded $inc, not a
      // read-modify-write on the loaded user document.
      expect(User.updateOne).toHaveBeenCalledWith(
        { _id: mockUserId, credits: { $gte: 1 } },
        { $inc: { credits: -1 } }
      );
      expect(res.body.remainingCredits).toEqual(9); // 10 - 1 = 9
      expect(Transaction.create).toHaveBeenCalled();
      expect(mockApplication.save).toHaveBeenCalled();
    });

    it("should reject with 403 if user has insufficient credits", async () => {
      // Mock user with 0 credits
      const poorUser = { ...mockUser, credits: 0 };
      User.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue(poorUser),
        then: jest.fn().mockImplementation(function(resolve) {
          return resolve(poorUser);
        }),
      });

      const res = await request(app)
        .post(`/api/interview-prep/${mockAppId}/grade-answer`)
        .set("Authorization", "Bearer mock-token")
        .send({
          questionText: "Tell me about React hooks.",
          questionIndex: 0,
          answerText: "React hook answer...",
        });

      expect(res.statusCode).toEqual(403);
      expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    });
  });

  describe("Story Bank — confidence + CRUD", () => {
    describe("PATCH /api/interview-prep/:applicationId/story-confidence", () => {
      it("should set story confidence by id", async () => {
        mockApplication.interviewPrep.stories = [{ id: "s1", title: "Led a migration" }];

        const res = await request(app)
          .patch(`/api/interview-prep/${mockAppId}/story-confidence`)
          .set("Authorization", "Bearer mock-token")
          .send({ storyId: "s1", confidence: "ready" });

        expect(res.statusCode).toEqual(200);
        expect(res.body.confidence).toEqual("ready");
        expect(mockApplication.interviewPrep.stories[0].confidence).toEqual("ready");
        expect(mockApplication.save).toHaveBeenCalled();
      });

      it("should reject an invalid confidence value", async () => {
        mockApplication.interviewPrep.stories = [{ id: "s1", title: "Led a migration" }];

        const res = await request(app)
          .patch(`/api/interview-prep/${mockAppId}/story-confidence`)
          .set("Authorization", "Bearer mock-token")
          .send({ storyId: "s1", confidence: "super-ready" });

        expect(res.statusCode).toEqual(400);
      });

      it("should 404 when the story id is unknown", async () => {
        mockApplication.interviewPrep.stories = [{ id: "s1" }];

        const res = await request(app)
          .patch(`/api/interview-prep/${mockAppId}/story-confidence`)
          .set("Authorization", "Bearer mock-token")
          .send({ storyId: "missing", confidence: "ready" });

        expect(res.statusCode).toEqual(404);
      });
    });

    describe("POST /api/interview-prep/:applicationId/stories", () => {
      it("should create a story with a server-assigned id", async () => {
        mockApplication.interviewPrep.stories = [];

        const res = await request(app)
          .post(`/api/interview-prep/${mockAppId}/stories`)
          .set("Authorization", "Bearer mock-token")
          .send({ title: "My new story", theme: "leadership" });

        expect(res.statusCode).toEqual(200);
        expect(res.body.story.id).toBeTruthy();
        expect(res.body.story.title).toEqual("My new story");
        expect(res.body.story.theme).toEqual("leadership");
        expect(mockApplication.save).toHaveBeenCalled();
      });
    });

    describe("PATCH /api/interview-prep/:applicationId/stories/:storyId", () => {
      it("should update editable fields and clear that story's warning", async () => {
        mockApplication.interviewPrep.stories = [{ id: "s2", title: "Old", situation: "before" }];
        mockApplication.interviewPrep.storyFabricationWarnings = [
          { index: 0, unsupportedClaims: ["made-up metric"] },
        ];

        const res = await request(app)
          .patch(`/api/interview-prep/${mockAppId}/stories/s2`)
          .set("Authorization", "Bearer mock-token")
          .send({ title: "New title", situation: "after" });

        expect(res.statusCode).toEqual(200);
        expect(res.body.story.title).toEqual("New title");
        expect(res.body.story.situation).toEqual("after");
        // Edit invalidates the AI fact-check for that story.
        expect(mockApplication.interviewPrep.storyFabricationWarnings).toHaveLength(0);
      });

      it("should 404 for an unknown story id", async () => {
        mockApplication.interviewPrep.stories = [{ id: "s2" }];

        const res = await request(app)
          .patch(`/api/interview-prep/${mockAppId}/stories/nope`)
          .set("Authorization", "Bearer mock-token")
          .send({ title: "x" });

        expect(res.statusCode).toEqual(404);
      });
    });

    describe("DELETE /api/interview-prep/:applicationId/stories/:storyId", () => {
      it("should remove the story and reindex remaining warnings", async () => {
        mockApplication.interviewPrep.stories = [{ id: "a" }, { id: "b" }];
        mockApplication.interviewPrep.storyFabricationWarnings = [
          { index: 0, unsupportedClaims: ["x"] },
          { index: 1, unsupportedClaims: ["y"] },
        ];

        const res = await request(app)
          .delete(`/api/interview-prep/${mockAppId}/stories/a`)
          .set("Authorization", "Bearer mock-token");

        expect(res.statusCode).toEqual(200);
        expect(mockApplication.interviewPrep.stories).toHaveLength(1);
        expect(mockApplication.interviewPrep.stories[0].id).toEqual("b");
        // Warning for deleted index 0 dropped; index 1 shifted down to 0.
        expect(mockApplication.interviewPrep.storyFabricationWarnings).toEqual([
          { index: 0, unsupportedClaims: ["y"] },
        ]);
      });

      it("should 404 when deleting an unknown story id", async () => {
        mockApplication.interviewPrep.stories = [{ id: "a" }];

        const res = await request(app)
          .delete(`/api/interview-prep/${mockAppId}/stories/missing`)
          .set("Authorization", "Bearer mock-token");

        expect(res.statusCode).toEqual(404);
      });
    });

    describe("POST /api/interview-prep/:applicationId/grade-story", () => {
      it("should grade a story, charge 1 credit, and set confidence", async () => {
        mockApplication.interviewPrep.stories = [
          { id: "st1", title: "Led migration", situation: "s", task: "t", action: "a", result: "r" },
        ];
        aiService.gradeInterviewAnswer.mockResolvedValue({
          score: 80,
          overallFeedback: "Solid delivery.",
          starBreakdown: {
            situation: { covered: true },
            task: { covered: true },
            action: { covered: true },
            result: { covered: false },
          },
          refinedAnswer: "Polished version...",
        });

        const res = await request(app)
          .post(`/api/interview-prep/${mockAppId}/grade-story`)
          .set("Authorization", "Bearer mock-token")
          .send({
            storyId: "st1",
            questionText: "Tell me about a time you led",
            answerText: "I led a migration under a tight deadline...",
          });

        expect(res.statusCode).toEqual(200);
        expect(res.body.score).toEqual(80);
        expect(res.body.confidence).toEqual("ready"); // score > 75
        expect(User.updateOne).toHaveBeenCalledWith(
          { _id: mockUserId, credits: { $gte: 1 } },
          { $inc: { credits: -1 } }
        );
        expect(mockApplication.interviewPrep.stories[0].confidence).toEqual("ready");
      });

      it("should 404 when the story id is unknown", async () => {
        mockApplication.interviewPrep.stories = [{ id: "st1" }];

        const res = await request(app)
          .post(`/api/interview-prep/${mockAppId}/grade-story`)
          .set("Authorization", "Bearer mock-token")
          .send({ storyId: "missing", answerText: "an answer" });

        expect(res.statusCode).toEqual(404);
      });
    });

    describe("POST /api/interview-prep/:applicationId/interview-session", () => {
      it("should save the self-assessed interview session result", async () => {
        mockApplication.interviewPrep.jobQuestions = [
          { question: "Tell me about React hooks.", suggestedAnswer: "...", type: "technical" },
        ];

        const res = await request(app)
          .post(`/api/interview-prep/${mockAppId}/interview-session`)
          .set("Authorization", "Bearer mock-token")
          .send({ confidence: "almost", durationSec: 600, plannedSec: 720, flaggedIndices: [0] });

        expect(res.statusCode).toEqual(200);
        expect(res.body.lastInterviewSession.confidence).toEqual("almost");
        expect(res.body.lastInterviewSession.flagged).toEqual([
          { index: 0, question: "Tell me about React hooks." },
        ]);
        expect(mockApplication.save).toHaveBeenCalled();
      });
    });
  });
});
