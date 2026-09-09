// RATING ONE MESSAGE, AND ONLY THE RIGHT ONE.
//
// 👍/👎 used to be addressable only as "the newest <operation> for this application".
// That is fine where an application has ONE current artifact — a cover letter, an
// analysis — and useless for a conversation, where every reply is the same operation and
// the newest is almost never the one being rated.
//
// So the endpoint that produces a chat turn now mints the AICallLog id BEFORE the model
// call and hands it back as `feedbackId`. These tests hold the two things that makes
// load-bearing: that the rating lands on the row named, and that naming a row is not the
// same as being allowed to write to it.
const request = require("supertest");
const app = require("../src/app");
const AICallLog = require("../src/models/AICallLog");
const Application = require("../src/models/Application");
const User = require("../src/models/User");
const SystemSettings = require("../src/models/SystemSettings");
const jwt = require("jsonwebtoken");

jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
// An explicit factory, not a bare automock: automocking a mongoose model leaves a
// Model-shaped object whose property access runs mongoose's compile helper, and
// user.controller requires this same model at import time — which crashed the whole
// suite before a single test ran.
jest.mock("../src/models/AICallLog", () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  deleteMany: jest.fn(),
  aggregate: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
}));
jest.mock("../src/models/Application");
jest.mock("../src/models/User");
jest.mock("../src/models/SystemSettings");
jest.mock("jsonwebtoken");

const userId = "60c72b2f9b1d8b2bad6e1a11";
const otherId = "60c72b2f9b1d8b2bad6e1a99";
const logId = "60c72b2f9b1d8b2bad6e1a33";

const post = (body) =>
  request(app).post("/api/ai-feedback").set("Authorization", "Bearer t").send(body);

const logDoc = (over = {}) => ({
  _id: logId,
  userId,
  operation: "coachChatTurn",
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: userId });
  // Without this the maintenance middleware waits 10s on a real Mongo connection.
  SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({ _id: userId, id: userId }),
  });
});

describe("POST /api/ai-feedback — by log id", () => {
  it("stamps the feedback on the row the client named", async () => {
    const log = logDoc();
    AICallLog.findById.mockResolvedValue(log);

    const res = await post({ logId, feedback: "up" });

    expect(res.status).toBe(200);
    expect(AICallLog.findById).toHaveBeenCalledWith(logId);
    expect(log.feedback).toBe("up");
    expect(log.feedbackAt).toBeInstanceOf(Date);
    expect(log.save).toHaveBeenCalled();
  });

  it("refuses to write to a log belonging to someone else", async () => {
    // There is no application standing in front of the row here, so this check IS the
    // authorization. Without it, a signed-in user could stamp an opinion onto anyone's
    // call by guessing an id.
    const log = logDoc({ userId: otherId });
    AICallLog.findById.mockResolvedValue(log);

    const res = await post({ logId, feedback: "down" });

    expect(res.status).toBe(401);
    expect(log.save).not.toHaveBeenCalled();
  });

  it("rejects an id that is not an ObjectId before touching the database", async () => {
    const res = await post({ logId: "not-an-id", feedback: "up" });

    expect(res.status).toBe(400);
    expect(AICallLog.findById).not.toHaveBeenCalled();
  });

  it("still rejects a feedback value that is not up or down", async () => {
    const res = await post({ logId, feedback: "meh" });

    expect(res.status).toBe(400);
    expect(AICallLog.findById).not.toHaveBeenCalled();
  });

  it("accepts the press even when the row is gone, rather than reporting failure", async () => {
    // The audit write is fire-and-forget and the rows are TTL'd at 90 days, so a rating
    // can genuinely arrive with nothing to attach to. The user pressed a thumb; telling
    // them their opinion errored would be a rebuke for helping.
    AICallLog.findById.mockResolvedValue(null);

    const res = await post({ logId, feedback: "up" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("noop");
  });
});

describe("POST /api/ai-feedback — the original application path still works", () => {
  it("resolves the newest log for an application the user owns", async () => {
    const applicationId = "60c72b2f9b1d8b2bad6e1a44";
    Application.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: applicationId, userId }),
    });
    const log = logDoc({ operation: "generateCoverLetter" });
    AICallLog.findOne.mockReturnValue({ sort: jest.fn().mockResolvedValue(log) });

    const res = await post({ applicationId, operation: "generateCoverLetter", feedback: "down" });

    expect(res.status).toBe(200);
    expect(log.feedback).toBe("down");
    // The log-id branch must not have been taken.
    expect(AICallLog.findById).not.toHaveBeenCalled();
  });

  it("still demands an identifier of some kind", async () => {
    const res = await post({ feedback: "up" });
    expect(res.status).toBe(400);
  });
});
