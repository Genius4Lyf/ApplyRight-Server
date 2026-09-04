const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Transaction = require("../src/models/Transaction");
const settingsService = require("../src/services/settings.service");
const subscription = require("../src/services/subscription.service");
const jwt = require("jsonwebtoken");

// POST /billing/unlock-template while the launch promo is running.
//
// The promo is checked on the SERVER, not only in the grid that hides the padlock. That
// matters because this endpoint is reachable directly, and because a client whose page
// was already open when the promo started would still be posting unlock requests — a
// UI-only promo would take 30 credits from exactly the people it was meant to be a gift
// to. Every assertion below is really "were they charged?".
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/Transaction");
jest.mock("../src/services/settings.service");
jest.mock("../src/services/subscription.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const PREMIUM = "executive-serif"; // anything outside config/templates FREE_TEMPLATE_IDS
const FREE = "ats-clean";

const inFuture = () => new Date(Date.now() + 60 * 60 * 1000);
const inPast = () => new Date(Date.now() - 60 * 60 * 1000);

const settings = (freeUntil) => ({
  features: { maintenanceMode: false },
  templates: { freeUntil },
});

const unlock = (templateId = PREMIUM) =>
  request(app)
    .post("/api/billing/unlock-template")
    .set("Authorization", "Bearer token")
    .send({ templateId });

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: mockUserId });

  const record = { _id: mockUserId, id: mockUserId, credits: 100, unlockedTemplates: [] };
  // findById serves both protect's .select() chain and the controller's bare await.
  User.findById.mockImplementation(() => {
    const p = Promise.resolve(record);
    p.select = jest.fn().mockResolvedValue(record);
    return p;
  });
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Transaction.create.mockResolvedValue({});

  subscription.hasPaidAccess.mockReturnValue(false);
  settingsService.getSettings.mockResolvedValue(settings(null));
  settingsService.getCreditCosts.mockResolvedValue({ TEMPLATE_UNLOCK: 30 });
});

describe("Template unlock — the launch promo", () => {
  it("charges nothing for a premium template while the promo runs", async () => {
    settingsService.getSettings.mockResolvedValue(settings(inFuture()));

    const res = await unlock();

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // The only assertion that really matters: no deduction was attempted.
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("leaves the balance exactly as it was", async () => {
    settingsService.getSettings.mockResolvedValue(settings(inFuture()));
    const res = await unlock();
    expect(res.body.credits).toBe(100);
  });

  it("does NOT permanently bank the template on the account", async () => {
    // The promo is a window, not a giveaway. Writing every template into
    // unlockedTemplates during it would keep them unlocked forever afterwards — the
    // promo would silently become a permanent price change.
    settingsService.getSettings.mockResolvedValue(settings(inFuture()));
    await unlock();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("charges again once the promo has expired", async () => {
    settingsService.getSettings.mockResolvedValue(settings(inPast()));

    const res = await unlock();

    expect(res.statusCode).toBe(200);
    expect(User.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = User.updateOne.mock.calls[0];
    expect(update.$inc.credits).toBe(-30);
    // The balance guard has to survive the promo being added above it.
    expect(filter.credits.$gte).toBe(30);
  });

  it("charges when no promo is configured at all", async () => {
    const res = await unlock();
    expect(res.statusCode).toBe(200);
    expect(User.updateOne).toHaveBeenCalledTimes(1);
  });

  it("still short-circuits genuinely free templates when the promo is off", async () => {
    const res = await unlock(FREE);
    expect(res.statusCode).toBe(200);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("still refuses an empty templateId during the promo", async () => {
    // The promo must not become a hole that skips validation.
    settingsService.getSettings.mockResolvedValue(settings(inFuture()));
    const res = await request(app)
      .post("/api/billing/unlock-template")
      .set("Authorization", "Bearer token")
      .send({});
    expect(res.statusCode).toBe(400);
  });
});
