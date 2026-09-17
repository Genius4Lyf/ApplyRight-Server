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
  ariaLive.buildAriaLiveInstructions.mockReturnValue("be warm");
  // The Realtime shape: an ephemeral client secret the BROWSER uses to talk to OpenAI. The
  // server never learns the session id, which is why settlement is a timer plus a sweep
  // rather than a sideband.
  ariaLive.mintAriaLiveSession.mockResolvedValue({
    clientSecret: "ek_test_123",
    expiresAt: 1800000000,
    model: "gpt-realtime-2.1-mini",
    voice: "marin",
    maxSessionSec: 120,
  });
});

afterEach(() => {
  jest.clearAllTimers();
});

describe("POST /api/aria-live/session — reserving the minutes", () => {
  it("has NO free taste — a first call with nothing bought is refused before OpenAI", async () => {
    // Owner's decision: talking to Aria is paid from the first second. A brand-new account
    // with no purchased minutes must get the out-of-minutes boundary, not a free call.
    asUser({ secondsRemaining: 0 });

    const res = await post({ section: "experience" });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("NO_ARIA_MINUTES");
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(ariaLive.mintAriaLiveSession).not.toHaveBeenCalled();
  });

  it("reserves from purchased minutes", async () => {
    asUser({ secondsRemaining: 900 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await post({ section: "project" });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("paid");
    expect(res.body.clientSecret).toBe("ek_test_123");
    const reserve = User.updateOne.mock.calls[0];
    expect(reserve[1].$inc).toEqual({ "ariaCall.secondsRemaining": -res.body.reservedSec });
    expect(reserve[1].$set["ariaCall.activeReservation"].mode).toBe("paid");
  });

  it("caps the call at the balance when it is smaller than the per-call limit", async () => {
    asUser({ secondsRemaining: 90 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await post({ section: "experience" });

    expect(res.body.reservedSec).toBe(90);
  });

  it("never reserves more than the per-call cap, however big the balance", async () => {
    asUser({ secondsRemaining: 36000 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await post({ section: "experience" });

    expect(res.body.reservedSec).toBeLessThanOrEqual(600);
  });

  it("402s with no minutes, and never calls OpenAI", async () => {
    asUser({ secondsRemaining: 0 });

    const res = await post({ section: "experience" });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("NO_ARIA_MINUTES");
    expect(ariaLive.mintAriaLiveSession).not.toHaveBeenCalled();
  });

  it("402s when the guarded reserve loses a race", async () => {
    asUser({ secondsRemaining: 300 });
    User.updateOne.mockResolvedValue({ modifiedCount: 0 });

    const res = await post({ section: "experience" });

    expect(res.status).toBe(402);
    expect(ariaLive.mintAriaLiveSession).not.toHaveBeenCalled();
  });

  it("refuses a second call while one could still be running", async () => {
    asUser({
      secondsRemaining: 600,
      activeReservation: {
        reservationId: "already-going",
        reservedSec: 600,
        startedAt: new Date(),
      },
    });

    const res = await post({ section: "experience" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CALL_IN_PROGRESS");
  });

  it("sweeps a DEAD reservation instead of locking the user out forever", async () => {
    // The failure this prevents: a tab closed mid-call (or a server restart that lost the
    // settle timer) used to leave activeReservation set for good, and every future call
    // answered "a call is already in progress" with no way back.
    asUser({
      secondsRemaining: 600,
      activeReservation: {
        reservationId: "crashed-call",
        reservedSec: 120,
        mode: "paid",
        startedAt: new Date(Date.now() - 600 * 1000),
      },
    });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await post({ section: "experience" });

    expect(res.status).toBe(200);
    // Settled first, at full price — we never heard how long it ran, and a call we cannot
    // account for must not be free.
    const settle = User.updateOne.mock.calls[0];
    expect(settle[0]["ariaCall.activeReservation.reservationId"]).toBe("crashed-call");
    expect(settle[1].$set["ariaCall.activeReservation"].reservationId).toBeNull();
  });

  it("only offers calls on roles and projects", async () => {
    asUser({ secondsRemaining: 600 });

    const res = await post({ section: "education" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_VOICE");
    expect(User.updateOne).not.toHaveBeenCalled();
  });
});

describe("POST /api/aria-live/session — refunding a failed mint", () => {
  it("puts PAID seconds back", async () => {
    asUser({ secondsRemaining: 600 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    ariaLive.mintAriaLiveSession.mockRejectedValue(new Error("upstream died"));

    const res = await post({ section: "experience" });

    expect(res.status).toBe(502);
    const refund = User.updateOne.mock.calls.at(-1);
    expect(refund[1].$inc["ariaCall.secondsRemaining"]).toBeGreaterThan(0);
    expect(refund[1].$set["ariaCall.activeReservation"].reservationId).toBeNull();
  });

  it("refunds the WHOLE reservation, since the call never started", async () => {
    asUser({ secondsRemaining: 300 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    ariaLive.mintAriaLiveSession.mockRejectedValue(new Error("upstream died"));

    await post({ section: "experience" });

    const [reserve, refund] = User.updateOne.mock.calls.map((c) => c[1]);
    expect(refund.$inc["ariaCall.secondsRemaining"]).toBe(
      -reserve.$inc["ariaCall.secondsRemaining"]
    );
  });

  it("503s rather than 502s when the key is missing", async () => {
    asUser({ secondsRemaining: 600 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const err = new Error("OPENAI_ARIA_LIVE_API_KEY not configured");
    err.code = "ARIA_LIVE_UNAVAILABLE";
    ariaLive.mintAriaLiveSession.mockRejectedValue(err);

    const res = await post({ section: "experience" });

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

  it("settles a leftover FREE-taste reservation without refunding into anything", async () => {
    // A call started before the taste was removed. It must still clear (or the user is locked
    // out with "a call is already in progress"), but there is no taste balance to refund
    // into — and it must never turn into purchased minutes.
    seed({ activeReservation: { ...activeReservation, mode: "free" } });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const settled = await settleReservation({ userId, reservationId, usedSec: 100 });

    const [, update] = User.updateOne.mock.calls[0];
    expect(settled).toBe(true);
    expect(update.$inc).toBeUndefined();
    expect(update.$set["ariaCall.activeReservation"].reservationId).toBeNull();
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
