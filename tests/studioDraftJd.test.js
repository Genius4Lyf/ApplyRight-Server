const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// Models + ai.service + jwt mocked. subscription.service is intentionally NOT mocked, so
// the REAL availableCredits/spendCredits run against the mocked User/Transaction — which
// is what makes "never charged when the draft is empty" a meaningful assertion rather
// than a test of our own stub. Mirrors studioScan.test.js's convention.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";

describe("POST /api/studio/draft-jd", () => {
  let mockUser;

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
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Transaction.create.mockResolvedValue({});
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    class AIUnavailableError extends Error {}
    aiService.AIUnavailableError = AIUnavailableError;
    aiService.draftJobDescription.mockResolvedValue(
      "Overview...\n\nResponsibilities\nDoes things\n\nRequirements\nKnows things"
    );
  });

  const post = (body = {}) =>
    request(app)
      .post("/api/studio/draft-jd")
      .set("Authorization", "Bearer token")
      .send({ jobTitle: "Wireline Field Operator", ...body });

  it("drafts a description and charges DRAFT_JD (light = 1)", async () => {
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.body.jobDescription).toMatch(/Responsibilities/);
    expect(res.body.cost).toBe(1);
    expect(aiService.draftJobDescription).toHaveBeenCalledWith(
      expect.objectContaining({ jobTitle: "Wireline Field Operator" })
    );
    expect(User.updateOne).toHaveBeenCalled();
    expect(Transaction.create).toHaveBeenCalledWith(expect.objectContaining({ type: "draft_jd" }));
  });

  it("ignores a flagship model pick — always drafts on Standard at the light price", async () => {
    const res = await post({ model: "claude-sonnet-5" });

    expect(res.statusCode).toBe(200);
    expect(res.body.cost).toBe(1);
    expect(Transaction.create).toHaveBeenCalledWith(expect.objectContaining({ type: "draft_jd" }));
  });

  it("does NOT charge when the model returns an empty description (scope guard or empty result)", async () => {
    aiService.draftJobDescription.mockResolvedValue("");

    const res = await post();

    expect(res.statusCode).toBe(502);
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("does NOT charge when draftJobDescription throws", async () => {
    aiService.draftJobDescription.mockRejectedValue(new Error("model exploded"));

    const res = await post();

    expect(res.statusCode).toBe(502);
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("does NOT charge when the AI is unavailable", async () => {
    aiService.draftJobDescription.mockRejectedValue(new aiService.AIUnavailableError("no key"));

    const res = await post();

    expect(res.statusCode).toBe(503);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("refuses before calling the AI when the balance is short", async () => {
    setUser({ credits: 0 });

    const res = await post();

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    expect(aiService.draftJobDescription).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("validates the job title", async () => {
    expect((await post({ jobTitle: "  " })).statusCode).toBe(400);
    expect((await post({ jobTitle: "x".repeat(121) })).statusCode).toBe(400);
    expect(aiService.draftJobDescription).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    const res = await request(app).post("/api/studio/draft-jd").send({ jobTitle: "Operator" });
    expect(res.statusCode).toBe(401);
  });
});

