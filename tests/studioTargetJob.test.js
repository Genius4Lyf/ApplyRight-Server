const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const userId = "60c72b2f9b1d8b2bad6e1a11";
const draftId = "60c72b2f9b1d8b2bad6e1a22";
const nextJob = {
  jobTitle: "Senior Wireline Operator",
  jobDescription:
    "Seeking a senior wireline operator with pressure-control, rig-up, reporting, and Excel experience.",
};

const draft = (overrides = {}) => ({
  _id: draftId,
  userId: { toString: () => userId },
  targetJob: {
    title: "Wireline Operator",
    description: "An older wireline operator job description with field duties.",
    source: "pasted",
    brief: { role: "Wireline Operator" },
    briefHash: "old-hash",
  },
  studioScan: { fitScore: 62, jdHash: "old-hash" },
  ...overrides,
});

describe("POST /api/studio/target-job", () => {
  let update;

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: userId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: userId, id: userId, role: "user" }),
    });
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    DraftCV.findById.mockResolvedValue(draft());
    aiService.buildRoleBrief.mockResolvedValue({
      role: "Senior Wireline Operator",
      mustHaves: [{ name: "Pressure control", importance: "must_have" }],
      responsibilities: ["Prepare and operate wireline equipment"],
    });
    DraftCV.findByIdAndUpdate.mockImplementation(async (_id, changes) => {
      update = changes;
      return {
        ...draft(),
        targetJob: {
          title: nextJob.jobTitle,
          description: nextJob.jobDescription,
          source: "pasted",
          brief: changes.$set["targetJob.brief"],
          briefHash: changes.$set["targetJob.briefHash"],
        },
        studioScan: undefined,
      };
    });
  });

  const post = (body = {}) =>
    request(app)
      .post("/api/studio/target-job")
      .set("Authorization", "Bearer token")
      .send({ draftId, ...nextJob, ...body });

  it("saves the JD and fresh Role Brief while invalidating every JD-derived cache", async () => {
    const response = await post();

    expect(response.statusCode).toBe(200);
    expect(response.body.changed).toBe(true);
    expect(response.body.targetJob.brief.role).toBe("Senior Wireline Operator");
    expect(update.$set).toEqual(
      expect.objectContaining({
        "targetJob.title": nextJob.jobTitle,
        "targetJob.description": nextJob.jobDescription,
        "targetJob.brief": expect.objectContaining({ role: "Senior Wireline Operator" }),
        "targetJob.briefHash": expect.any(String),
        "tailoredForJob.title": nextJob.jobTitle,
      })
    );
    expect(update.$unset).toEqual(
      expect.objectContaining({
        "targetJob.aiKeywords": 1,
        "targetJob.aiKeywordsHash": 1,
        skillsGenCache: 1,
        studioScan: 1,
        genState: 1,
      })
    );
  });

  it("still saves the user's JD when the advisory Role Brief cannot be generated", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    aiService.buildRoleBrief.mockRejectedValueOnce(new Error("AI unavailable"));

    const response = await post();

    expect(response.statusCode).toBe(200);
    expect(update.$set["targetJob.description"]).toBe(nextJob.jobDescription);
    expect(update.$set["targetJob.brief"]).toBeUndefined();
    expect(update.$unset["targetJob.brief"]).toBe(1);
    expect(update.$unset["targetJob.briefHash"]).toBe(1);
    errorSpy.mockRestore();
  });

  it("rejects invalid input and drafts belonging to another user", async () => {
    expect((await post({ jobDescription: "too short" })).statusCode).toBe(400);
    expect((await post({ draftId: "not-an-id" })).statusCode).toBe(400);

    DraftCV.findById.mockResolvedValueOnce(
      draft({ userId: { toString: () => "60c72b2f9b1d8b2bad6e1a99" } })
    );
    expect((await post()).statusCode).toBe(403);
  });
});
