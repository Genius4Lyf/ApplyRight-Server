// Aria Live — the minute accounting.
//
// Everything here is about money, so it is pinned harder than the feature around it. The
// interview's equivalent tests cover the FREE bucket only; the paid reserve and the paid
// refund-on-mint-failure have never been asserted anywhere, and they are exactly the paths
// where a bug costs a user minutes they bought.
const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Transaction = require("../src/models/Transaction");
const DraftCV = require("../src/models/DraftCV");
const ariaLive = require("../src/services/ariaLive.service");
const { settleReservation } = require("../src/controllers/ariaLive.controller");
const { ARIA_CALL_FREE_TASTE_SEC } = require("../src/config/catalog");
const jwt = require("jsonwebtoken");

jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
// Without this the maintenance middleware reaches for a real Mongo connection on EVERY
// request and each test dies on a 10s buffering timeout rather than on its assertion.
jest.mock("../src/models/SystemSettings");
jest.mock("../src/models/User");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/DraftCV");
jest.mock("../src/services/ariaLive.service");
jest.mock("jsonwebtoken");

const userId = "60c72b2f9b1d8b2bad6e1a11";
const OFFER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n";

// One user, two call shapes. protect() awaits findById().select("-password") directly,
// while the controller reads findById().select("ariaCall").lean() — so select() returns a
// promise that ALSO carries .lean(), and both styles resolve to the same document.
const asUser = (ariaCall) => {
  jwt.verify.mockReturnValue({ id: userId });
  const doc = { _id: userId, ariaCall };
  User.findById.mockImplementation(() => ({
    select: () => {
      const p = Promise.resolve(doc);
      p.lean = () => Promise.resolve(doc);
      return p;
    },
  }));
};

const post = (body) =>
  request(app).post("/api/aria-live/session").set("Authorization", "Bearer t").send(body);

beforeEach(() => {
  jest.clearAllMocks();
  DraftCV.findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  });
  Transaction.create.mockResolvedValue({});
  ariaLive.attachSideband.mockReturnValue({ close: jest.fn() });
  ariaLive.buildAriaLiveInstructions.mockReturnValue("be warm");
  ariaLive.mintAriaLiveSession.mockResolvedValue({
    sessionId: "live_123",
    sdp: "answer-sdp",
    model: "gpt-live-1",
    voice: "marin",
    maxSessionSec: 120,
  });
});

describe("POST /api/aria-live/session — reserving the minutes", () => {
  it("spends the free taste when nothing has been bought", async () => {
    asUser({ secondsRemaining: 0, freeTasteUsedSec: 0 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await post({ sdp: OFFER, section: "experience" });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("free");
    expect(res.body.sdp).toBe("answer-sdp");
    // The taste is the whole budget, so the call is capped at it rather than at the
    // 10-minute per-call ceiling.
    expect(res.body.reservedSec).toBe(ARIA_CALL_FREE_TASTE_SEC);

    const reserve = User.updateOne.mock.calls[0];
    expect(reserve[1].$inc["ariaCall.freeTasteUsedSec"]).toBe(ARIA_CALL_FREE_TASTE_SEC);
    expect(reserve[1].$set["ariaCall.activeReservation"].mode).toBe("free");
  });

  it("spends PURCHASED minutes first, even with taste left", async () => {
    // The interview shipped with this backwards — it picked the bucket by TIER, so a free
    // user could never spend minutes they had paid for.
    asUser({ secondsRemaining: 900, freeTasteUsedSec: 0 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await post({ sdp: OFFER, section: "project" });

    expect(res.body.mode).toBe("paid");
    const reserve = User.updateOne.mock.calls[0];
    expect(reserve[1].$inc["ariaCall.secondsRemaining"]).toBeLessThan(0);
    expect(reserve[1].$inc["ariaCall.freeTasteUsedSec"]).toBeUndefined();
  });

  it("never reserves more than the per-call cap, however big the balance", async () => {
    asUser({ secondsRemaining: 36000, freeTasteUsedSec: 0 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await post({ sdp: OFFER, section: "experience" });

    expect(res.body.reservedSec).toBeLessThanOrEqual(600);
  });

  it("402s with no minutes, and never calls OpenAI", async () => {
    asUser({ secondsRemaining: 0, freeTasteUsedSec: ARIA_CALL_FREE_TASTE_SEC });

    const res = await post({ sdp: OFFER, section: "experience" });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("NO_ARIA_MINUTES");
    expect(ariaLive.mintAriaLiveSession).not.toHaveBeenCalled();
  });

  it("402s when the guarded reserve loses a race", async () => {
    asUser({ secondsRemaining: 300, freeTasteUsedSec: 0 });
    User.updateOne.mockResolvedValue({ modifiedCount: 0 });

    const res = await post({ sdp: OFFER, section: "experience" });

    expect(res.status).toBe(402);
    expect(ariaLive.mintAriaLiveSession).not.toHaveBeenCalled();
  });

  it("refuses a second call while one is already live", async () => {
    asUser({
      secondsRemaining: 600,
      freeTasteUsedSec: 0,
      activeReservation: { reservationId: "already-going" },
    });

    const res = await post({ sdp: OFFER, section: "experience" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CALL_IN_PROGRESS");
  });

  it("only offers calls on roles and projects", async () => {
    asUser({ secondsRemaining: 600, freeTasteUsedSec: 0 });

    const res = await post({ sdp: OFFER, section: "education" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_VOICE");
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("requires an SDP offer before touching the balance", async () => {
    asUser({ secondsRemaining: 600, freeTasteUsedSec: 0 });

    const res = await post({ section: "experience" });

    expect(res.status).toBe(400);
    expect(User.updateOne).not.toHaveBeenCalled();
  });
});

describe("POST /api/aria-live/session — refunding a failed mint", () => {
  it("puts PAID seconds back", async () => {
    asUser({ secondsRemaining: 600, freeTasteUsedSec: 0 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    ariaLive.mintAriaLiveSession.mockRejectedValue(new Error("upstream died"));

    const res = await post({ sdp: OFFER, section: "experience" });

    expect(res.status).toBe(502);
    const refund = User.updateOne.mock.calls.at(-1);
    expect(refund[1].$inc["ariaCall.secondsRemaining"]).toBeGreaterThan(0);
    expect(refund[1].$set["ariaCall.activeReservation"].reservationId).toBeNull();
  });

  it("puts the FREE TASTE back, rather than crediting the paid bucket", async () => {
    // The bug this exists for: two of the interview's three refund sites credit
    // secondsRemaining unconditionally, so a free session that failed to mint silently
    // burned the user's one taste and gave them paid minutes they never bought.
    asUser({ secondsRemaining: 0, freeTasteUsedSec: 0 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    ariaLive.mintAriaLiveSession.mockRejectedValue(new Error("upstream died"));

    await post({ sdp: OFFER, section: "experience" });

    const refund = User.updateOne.mock.calls.at(-1);
    expect(refund[1].$inc["ariaCall.freeTasteUsedSec"]).toBe(-ARIA_CALL_FREE_TASTE_SEC);
    expect(refund[1].$inc["ariaCall.secondsRemaining"]).toBeUndefined();
  });

  it("503s rather than 502s when the key is missing", async () => {
    asUser({ secondsRemaining: 600, freeTasteUsedSec: 0 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const err = new Error("OPENAI_ARIA_LIVE_API_KEY not configured");
    err.code = "ARIA_LIVE_UNAVAILABLE";
    ariaLive.mintAriaLiveSession.mockRejectedValue(err);

    const res = await post({ sdp: OFFER, section: "experience" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("ARIA_LIVE_UNAVAILABLE");
  });
});

describe("settleReservation — what the call actually cost", () => {
  const reservationId = "res-1";
  const activeReservation = { reservationId, reservedSec: 300, mode: "paid" };

  const seed = (ariaCall) => asUser(ariaCall);

  it("refunds the unused remainder to the bucket that paid", async () => {
    seed({ activeReservation });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await settleReservation({ userId, reservationId, usedSec: 110 });

    const [, update] = User.updateOne.mock.calls[0];
    expect(update.$inc["ariaCall.secondsRemaining"]).toBe(190);
    expect(update.$set["ariaCall.activeReservation"].reservationId).toBeNull();
  });

  it("gives the FREE taste back when that was the bucket", async () => {
    seed({ activeReservation: { ...activeReservation, mode: "free" } });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await settleReservation({ userId, reservationId, usedSec: 100 });

    const [, update] = User.updateOne.mock.calls[0];
    expect(update.$inc["ariaCall.freeTasteUsedSec"]).toBe(-200);
  });

  it("clamps a reported duration to what was reserved", async () => {
    // The trust boundary: a client may only ever reduce the bill, never extend it into
    // minutes the user does not have.
    seed({ activeReservation });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await settleReservation({ userId, reservationId, usedSec: 99999 });

    const [, update] = User.updateOne.mock.calls[0];
    expect(update.$inc).toBeUndefined(); // nothing to refund — the whole reservation was used
    expect(Transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Aria call 300s", amount: 0 })
    );
  });

  it("is idempotent — the sideband and the client both settling writes once", async () => {
    seed({ activeReservation });
    User.updateOne.mockResolvedValue({ modifiedCount: 0 }); // someone got here first

    const settled = await settleReservation({ userId, reservationId, usedSec: 100 });

    expect(settled).toBe(false);
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("ignores a reservation id that is not the live one", async () => {
    seed({ activeReservation: { ...activeReservation, reservationId: "someone-elses" } });

    const settled = await settleReservation({ userId, reservationId, usedSec: 100 });

    expect(settled).toBe(false);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("records minutes as usage, never as a credit movement", async () => {
    seed({ activeReservation });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await settleReservation({ userId, reservationId, usedSec: 42 });

    expect(Transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "usage", amount: 0 })
    );
  });
});
