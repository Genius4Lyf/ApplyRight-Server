const request = require("supertest");
const app = require("../src/app");
const DraftCV = require("../src/models/DraftCV");
const User = require("../src/models/User");
const SystemSettings = require("../src/models/SystemSettings");
const jwt = require("jsonwebtoken");

// The sidebar's list endpoint. Two things matter here and nothing else does: that the
// SCOPE decides which CVs come back, and that the projection stays lean — this route is
// hit from every CV surface, so content leaking into it is a payload regression nobody
// would notice until the app felt slow.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/User");
jest.mock("../src/models/SystemSettings");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";

describe("GET /api/cv/list", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: mockUserId, id: mockUserId }),
    });
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    DraftCV.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
  });

  const get = (qs = "") =>
    request(app).get(`/api/cv/list${qs}`).set("Authorization", "Bearer token");

  const queryArg = () => DraftCV.find.mock.calls[0][0];
  const projectionArg = () => DraftCV.find.mock.calls[0][1];

  it("scopes to CVs not born in Aria by default", async () => {
    const res = await get();

    expect(res.statusCode).toBe(200);
    // null, not { $exists: false } — this has to match drafts that predate the field as
    // well as ones that carry it unset, and in Mongo `null` matches both.
    expect(queryArg()).toEqual({ userId: mockUserId, studioKind: null });
  });

  it("returns every CV when the caller asks for all", async () => {
    await get("?scope=all");
    expect(queryArg().studioKind).toBeUndefined();
    expect(queryArg().userId).toBe(mockUserId);
  });

  it("treats an unrecognised scope as the narrow one", async () => {
    // Failing closed: a typo should show too little, never silently widen the list past
    // what the caller asked for.
    await get("?scope=everything");
    expect(queryArg().studioKind).toBe(null);
  });

  it("projects section arrays to ids alone, and no CV content", async () => {
    await get();
    const projection = projectionArg();

    // Presence is all getCompletionStatus asks of these, and an array of bare ids answers
    // it without carrying a single bullet.
    expect(projection["experience._id"]).toBe(1);
    expect(projection["education._id"]).toBe(1);
    expect(projection["skills._id"]).toBe(1);
    expect(projection.experience).toBeUndefined();

    // The heavy fields that make a whole draft expensive.
    ["coachChats", "studioScan", "targetJob", "tailoredForJob"].forEach((field) => {
      expect(projection[field]).toBeUndefined();
    });
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await request(app).get("/api/cv/list");
    expect(res.statusCode).toBe(401);
  });
});
