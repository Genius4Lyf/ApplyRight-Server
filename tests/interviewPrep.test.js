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
});
