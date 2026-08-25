const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// Models + ai.service + jwt mocked; subscription.service and modelSelection are REAL, so
// the actual availableCredits/spendCredits/resolveForAction run against the mocked
// User/Transaction — that is what makes the charge assertions genuine. Mirrors
// studioRewriteRole.test.js.
//
// The bug this guards against: generateBullets used to charge for the REQUESTED count (n)
// even when the evidence-citation guardrail (and its backfill retry, now inside
// aiService.generateBulletsFromDescription) silently delivered fewer bullets than asked —
// the user was billed for 5 and shown 2. These tests drive the controller directly with a
// mocked aiService.generateBulletsFromDescription standing in for the (separately tested)
// backfill logic, and assert the controller charges/reports the ACTUAL delivered count.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const draftId = "60c72b2f9b1d8b2bad6e1a22";
const SORT_ID = "role-1";

const detail = (text, evidenceIds = ["ev_1"]) => ({ text, evidenceIds, requirementIds: [] });

const buildDraft = (over = {}) => ({
  _id: draftId,
  userId: { toString: () => mockUserId },
  experience: [{ _sortId: SORT_ID, title: "Engineer", company: "Acme", description: "" }],
  projects: [],
  coachEvidence: {
    [SORT_ID]: {
      evidence: [{ id: "ev_1", claim: "Cut latency", sourceQuote: "I cut latency" }],
    },
  },
  genState: {},
  markModified: jest.fn(),
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

describe("POST /api/coach/generate-bullets", () => {
  let mockUser;
  let draft;

  const setUser = (over = {}) => {
    mockUser = {
      _id: mockUserId,
      id: mockUserId,
      credits: 50,
      plan: "free",
      subscription: undefined,
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
    draft = buildDraft();
    DraftCV.findById.mockResolvedValue(draft);
  });

  const post = (body = {}) =>
    request(app)
      .post("/api/coach/generate-bullets")
      .set("Authorization", "Bearer token")
      .send({
        draftId,
        section: "experience",
        sortId: SORT_ID,
        description: "Handled the checkout pipeline end to end for the team.",
        count: 5,
        ...body,
      });

  it("charges for the ACTUAL delivered count, not the requested count", async () => {
    // Requested 5; the (separately tested) citation guardrail + backfill inside
    // aiService only managed to deliver 2 — this is exactly the reported symptom.
    aiService.generateBulletsFromDescription.mockResolvedValue([
      detail("Cut checkout latency by streamlining the payment call"),
      detail("Resolved recurring cart-abandonment bugs"),
    ]);

    const res = await post({ count: 5 });

    expect(res.statusCode).toBe(200);
    expect(res.body.bullets).toHaveLength(2);
    expect(res.body.cost).toBe(2); // 2 delivered × 1 credit (light tier), NOT 5
    expect(Transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Aria bullets (2)" })
    );
    expect(User.updateOne).toHaveBeenCalled();
  });

  it("charges the full requested count when every bullet survives", async () => {
    aiService.generateBulletsFromDescription.mockResolvedValue([
      detail("Bullet one"),
      detail("Bullet two"),
      detail("Bullet three"),
      detail("Bullet four"),
      detail("Bullet five"),
    ]);

    const res = await post({ count: 5 });

    expect(res.statusCode).toBe(200);
    expect(res.body.bullets).toHaveLength(5);
    expect(res.body.cost).toBe(5);
  });

  it("pre-checks the balance against the WORST-CASE (requested) count before calling the AI", async () => {
    setUser({ credits: 3 }); // enough for 3, not 5

    const res = await post({ count: 5 });

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    expect(res.body.required).toBe(5);
    expect(aiService.generateBulletsFromDescription).not.toHaveBeenCalled();
  });

  // The picker offers 3/4/5/6/8, so 8 must be a legal request and 9 must not — the
  // controller bound and the ai.service clamp have to move together, or an 8 request
  // silently comes back clamped to a stale ceiling with no error.
  it("accepts the picker's maximum of 8", async () => {
    aiService.generateBulletsFromDescription.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => detail(`Bullet ${i + 1}`))
    );
    setUser({ credits: 100 });

    const res = await post({ count: 8 });

    expect(res.statusCode).toBe(200);
    expect(res.body.bullets).toHaveLength(8);
    expect(aiService.generateBulletsFromDescription).toHaveBeenCalledWith(
      expect.any(String),
      8,
      expect.any(Object)
    );
  });

  it("rejects a count above the picker's maximum", async () => {
    const res = await post({ count: 9 });

    expect(res.statusCode).toBe(400);
    expect(aiService.generateBulletsFromDescription).not.toHaveBeenCalled();
  });

  it("502s (and does not charge) when the AI delivers nothing usable", async () => {
    aiService.generateBulletsFromDescription.mockResolvedValue([]);

    const res = await post();

    expect(res.statusCode).toBe(502);
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("passes the draft's evidence ledger for the entry through to generation", async () => {
    aiService.generateBulletsFromDescription.mockResolvedValue([detail("Bullet one")]);

    await post({ count: 3 });

    expect(aiService.generateBulletsFromDescription).toHaveBeenCalledWith(
      expect.any(String),
      3,
      expect.objectContaining({
        evidenceLedger: draft.coachEvidence[SORT_ID],
      })
    );
  });
});
