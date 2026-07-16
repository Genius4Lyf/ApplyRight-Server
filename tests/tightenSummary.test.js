const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// Mock models + services (mirrors interviewPrep.test.js). subscription.service is
// intentionally NOT mocked so the real chargeOrSkip/spendCredits runs against the
// mocked User/Transaction models — proving the charge (or its absence) for real.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";

// A long-ish, real-looking professional summary to compress (> 20, < 2000 chars).
const LONG_SUMMARY =
  "Results-oriented software engineer with over eight years of professional experience " +
  "designing, building, and maintaining large-scale web applications across fintech and " +
  "e-commerce, leading small cross-functional teams, mentoring junior developers, and " +
  "consistently shipping reliable, well-tested features on time and within scope.";

describe("POST /api/ai/tighten-summary", () => {
  let mockUser;

  beforeEach(() => {
    jest.clearAllMocks();

    mockUser = {
      _id: mockUserId,
      id: mockUserId,
      email: "candidate@example.com",
      credits: 10,
    };

    jwt.verify.mockReturnValue({ id: mockUserId });
    // `protect` does User.findById(id).select("-password")
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(mockUser),
    });
    // Atomic credit deduction inside spendCredits — default to a successful decrement.
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Transaction.create.mockResolvedValue({});
    // Maintenance middleware.
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
  });

  it("returns a shorter tightened summary and the remaining credits (charges 1)", async () => {
    const tightened =
      "Software engineer, 8+ years across fintech and e-commerce. Led teams and shipped reliable features.";
    aiService.tightenSummary.mockResolvedValue(tightened);

    const res = await request(app)
      .post("/api/ai/tighten-summary")
      .set("Authorization", "Bearer mock-token")
      .send({ text: LONG_SUMMARY });

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.tightened).toBe("string");
    // The rewrite is shorter than the original.
    expect(res.body.tightened.length).toBeLessThan(LONG_SUMMARY.length);
    expect(typeof res.body.remainingCredits).toBe("number");
    // The service was called with the original text.
    expect(aiService.tightenSummary).toHaveBeenCalledWith(LONG_SUMMARY, expect.any(Object));
    // 1 credit was charged (from the wallet: 10 → 9).
    expect(res.body.remainingCredits).toBe(9);
    expect(Transaction.create).toHaveBeenCalledTimes(1);
  });

  it("returns 503 and does NOT charge when the AI is unavailable", async () => {
    aiService.tightenSummary.mockRejectedValue(
      Object.assign(new Error("AI service is not configured."), { code: "AI_UNAVAILABLE" })
    );

    const res = await request(app)
      .post("/api/ai/tighten-summary")
      .set("Authorization", "Bearer mock-token")
      .send({ text: LONG_SUMMARY });

    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("AI_UNAVAILABLE");
    // No charge: the deduction runs only AFTER a successful AI call.
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("returns 400 for a too-short summary (no AI call)", async () => {
    const res = await request(app)
      .post("/api/ai/tighten-summary")
      .set("Authorization", "Bearer mock-token")
      .send({ text: "too short" });

    expect(res.statusCode).toBe(400);
    expect(aiService.tightenSummary).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });
});
