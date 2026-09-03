const request = require("supertest");
const app = require("../src/app");
const DraftCV = require("../src/models/DraftCV");
const User = require("../src/models/User");
const SettingsService = require("../src/services/settings.service");
const jwt = require("jsonwebtoken");

// checkMaintenanceMode is mounted globally in app.js, AHEAD of every route's own
// `protect` — so req.user does not exist at the point this middleware runs, and the
// bypass it grants (admin, or an admin-set User.maintenanceAccess for an early-access
// / awareness-campaign cohort) has to decode the token itself. This pins that
// decision through a real protected route (GET /api/cv/list) rather than testing the
// middleware in isolation, so a regression that broke the ORDER of these two checks
// would show up here too.
//
// SettingsService is mocked directly (not the SystemSettings model): automocking the
// model replaces its `getInstance` static with a no-op returning undefined, which
// makes checkMaintenanceMode's own try/catch silently "fail open" on every test
// regardless of what the mock is told to return — a trap that cost a debugging pass
// before this file existed. Mocking the service the middleware actually calls avoids it.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/User");
jest.mock("../src/services/settings.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";

describe("Maintenance mode gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SettingsService.getSettings.mockResolvedValue({ features: { maintenanceMode: true } });
    DraftCV.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
  });

  const get = (auth) => {
    const req = request(app).get("/api/cv/list");
    return auth ? req.set("Authorization", `Bearer ${auth}`) : req;
  };

  it("blocks a guest with no token", async () => {
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.body.maintenance).toBe(true);
  });

  it("blocks an invalid or expired token", async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error("jwt expired");
    });
    const res = await get("stale-token");
    expect(res.statusCode).toBe(503);
  });

  it("blocks a plain logged-in user", async () => {
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ role: "user", maintenanceAccess: false }),
    });
    const res = await get("token");
    expect(res.statusCode).toBe(503);
  });

  // The bug this suite exists to pin: checkMaintenanceMode used to test
  // `req.user?.role === "admin"`, but req.user is never populated this early — every
  // admin was getting the 503 too, same as everyone else.
  it("lets an admin through", async () => {
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ role: "admin", maintenanceAccess: false }),
    });
    const res = await get("token");
    expect(res.statusCode).toBe(200);
  });

  it("lets a user with a maintenance-access grant through", async () => {
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ role: "user", maintenanceAccess: true }),
    });
    const res = await get("token");
    expect(res.statusCode).toBe(200);
  });

  it("is a no-op once maintenance mode is off", async () => {
    SettingsService.getSettings.mockResolvedValue({ features: { maintenanceMode: false } });
    const res = await get();
    // No token at all — would 401 from the route's own `protect`, not 503 from this
    // gate. Proves the gate itself stepped aside rather than merely admitting a user
    // it happened to recognise.
    expect(res.statusCode).toBe(401);
  });
});

// The single write that stays open behind the pre-launch gate. A campaign signup has to
// be able to hand over their details before the countdown, so the onboarding save is
// exempt — but only while the campaign is running, only for an account that has not
// finished, and only on that exact request. These tests exist to keep it that narrow:
// widened by accident it becomes a general write channel through a closed app.
describe("Maintenance gate — the onboarding exemption", () => {
  const campaignOn = (over = {}) =>
    SettingsService.getSettings.mockResolvedValue({
      features: { maintenanceMode: true },
      launch: { enabled: true },
      ...over,
    });

  const asUser = (over = {}) => {
    jwt.verify.mockReturnValue({ id: mockUserId });
    const record = { _id: mockUserId, role: "user", maintenanceAccess: false, ...over };
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(record) });
    User.findByIdAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue(record) });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    campaignOn();
  });

  const save = () =>
    request(app)
      .put("/api/users/profile")
      .set("Authorization", "Bearer token")
      .send({ firstName: "Ada", lastName: "Lovelace", onboardingCompleted: true });

  // Asserted as "not 503" rather than 200: the gate is what is under test, and whatever
  // the controller does next is a different suite's business.
  it("lets an unfinished registrant save their onboarding", async () => {
    asUser({ onboardingCompleted: false });
    const res = await save();
    expect(res.statusCode).not.toBe(503);
  });

  it("closes again once they have finished", async () => {
    asUser({ onboardingCompleted: true });
    const res = await save();
    expect(res.statusCode).toBe(503);
  });

  it("does not open during an ORDINARY outage", async () => {
    // Maintenance without the campaign means the app is genuinely down. Letting someone
    // fill in a form here would only waste their time.
    campaignOn({ launch: { enabled: false } });
    asUser({ onboardingCompleted: false });
    const res = await save();
    expect(res.statusCode).toBe(503);
  });

  it("does not open the rest of the user API", async () => {
    asUser({ onboardingCompleted: false });
    const res = await request(app)
      .get("/api/users/profile")
      .set("Authorization", "Bearer token");
    expect(res.statusCode).toBe(503);
  });

  it("does not open the account DELETE on the same path", async () => {
    // Same URL, different verb — the exemption is keyed on both.
    asUser({ onboardingCompleted: false });
    const res = await request(app)
      .delete("/api/users/profile")
      .set("Authorization", "Bearer token");
    expect(res.statusCode).toBe(503);
  });

  it("does not open for a guest with no token", async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error("no token");
    });
    const res = await request(app).put("/api/users/profile").send({ firstName: "Ada" });
    expect(res.statusCode).toBe(503);
  });
});
