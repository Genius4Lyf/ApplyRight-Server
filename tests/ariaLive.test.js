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
// The trade-vocabulary lookup. Stubbed so these tests never reach a model.
jest.mock("../src/services/ai.service", () => ({
  inferRoleKeywords: jest.fn(),
  cvDigest: jest.fn(() => ""),
}));
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

describe("POST /api/aria-live/session — the call is given the conversation so far", () => {
  // Both halves of the build share one memory: the typed interview already reads the spoken
  // turns (they are in the same chat window), and this is the other direction. Without it a
  // second call opens with "tell me what you actually did" and bills the user to repeat
  // themselves — which is exactly what happened after the first call dropped.
  const pinned = "sort-1";
  const stream = [
    { who: "aria", text: "Which section next?" },
    { who: "pinrole", sortId: "sort-OLD" },
    { who: "user", text: "A DIFFERENT role entirely." },
    { who: "rolerecord", sortId: "sort-OLD" },
    { who: "pinrole", sortId: pinned },
    { who: "aria", text: "Tell me what you did day to day." },
    { who: "user", text: "I kept the acquisition unit running." },
    { who: "calltips" },
    { who: "user", text: "This one never sent.", failed: true },
    { who: "aria", text: "Did you spot anything before anyone else?" },
  ];

  const withDraft = (draft) =>
    DraftCV.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(draft) }),
    });

  const promptArgs = () => ariaLive.buildAriaLiveInstructions.mock.calls.at(-1)[0];

  beforeEach(() => {
    asUser({ secondsRemaining: 600 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it("passes THIS entry's turns, and only the real ones", async () => {
    withDraft({
      experience: [{ _sortId: pinned, title: "Wireline Operator" }],
      coachChats: { studio: stream },
    });

    await post({ section: "experience", draftId: "60c72b2f9b1d8b2bad6e1a22", sortId: pinned });

    const { priorTurns } = promptArgs();
    expect(priorTurns.map((t) => t.text)).toEqual([
      "Tell me what you did day to day.",
      "I kept the acquisition unit running.",
      "Did you spot anything before anyone else?",
    ]);
    // A turn that never reached the server is not something she was told.
    expect(JSON.stringify(priorTurns)).not.toContain("never sent");
    // Nor is another role's conversation.
    expect(JSON.stringify(priorTurns)).not.toContain("DIFFERENT role");
  });

  it("picks the entry by sortId, not 'the last one in the list'", async () => {
    withDraft({
      experience: [
        { _sortId: pinned, title: "Wireline Operator" },
        { _sortId: "sort-9", title: "Something Else" },
      ],
      coachChats: { studio: stream },
    });

    await post({ section: "experience", draftId: "60c72b2f9b1d8b2bad6e1a22", sortId: pinned });

    expect(promptArgs().entryTitle).toBe("Wireline Operator");
  });

  it("still falls back to the newest entry when no sortId is sent", async () => {
    withDraft({
      experience: [
        { _sortId: "a", title: "Older" },
        { _sortId: "b", title: "Newest" },
      ],
      coachChats: { studio: [] },
    });

    await post({ section: "experience", draftId: "60c72b2f9b1d8b2bad6e1a22" });

    expect(promptArgs().entryTitle).toBe("Newest");
    expect(promptArgs().priorTurns).toEqual([]);
  });

  it("sends no history for an entry that has never been opened", async () => {
    withDraft({
      experience: [{ _sortId: "never-pinned", title: "Fresh" }],
      coachChats: { studio: stream },
    });

    await post({
      section: "experience",
      draftId: "60c72b2f9b1d8b2bad6e1a22",
      sortId: "never-pinned",
    });

    expect(promptArgs().priorTurns).toEqual([]);
  });

  it("starts the call anyway when the transcript cannot be read", async () => {
    DraftCV.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error("boom")) }),
    });

    const res = await post({
      section: "experience",
      draftId: "60c72b2f9b1d8b2bad6e1a22",
      sortId: pinned,
    });

    // A missing memory is a worse call, not a failed one.
    expect(res.status).toBe(200);
    expect(promptArgs().priorTurns).toEqual([]);
  });
});

describe("POST /api/aria-live/session — the trade vocabulary comes from THIS entry", () => {
  const aiService = require("../src/services/ai.service");
  const draftId = "60c72b2f9b1d8b2bad6e1a22";

  const withDraft = (draft) =>
    DraftCV.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(draft) }),
    });

  const promptArgs = () => ariaLive.buildAriaLiveInstructions.mock.calls.at(-1)[0];

  beforeEach(() => {
    asUser({ secondsRemaining: 600 });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    aiService.inferRoleKeywords.mockReset();
    aiService.inferRoleKeywords.mockResolvedValue({ keywords: [{ name: "lesson planning" }] });
  });

  it("asks about the entry being interviewed, NOT the first one on the CV", async () => {
    // The draft-level cache describes the target job, or failing that whatever the FIRST entry
    // happens to be. Handing that to an interview about the third entry puts one role's words
    // into another role's questions — the register bug, arriving as data instead of prose.
    withDraft({
      experience: [
        { _sortId: "s1", title: "Wireline Field Operator" },
        { _sortId: "s2", title: "Sales Assistant" },
        { _sortId: "s3", title: "Teaching Assistant" },
      ],
      targetJob: {
        noJd: { roleFamily: "wireline field operator", keywords: [{ name: "well logging" }] },
      },
    });

    await post({ section: "experience", draftId, sortId: "s3" });

    expect(aiService.inferRoleKeywords).toHaveBeenCalledWith(
      "Teaching Assistant",
      expect.any(Object)
    );
    expect(promptArgs().roleFamily ?? promptArgs().noJd.roleFamily).toBe("Teaching Assistant");
    // The other role's vocabulary must not have travelled with it.
    expect(JSON.stringify(promptArgs().noJd)).not.toContain("well logging");
  });

  it("does not infer when a real job description already says what the role wants", async () => {
    withDraft({
      experience: [{ _sortId: "s1", title: "Teaching Assistant" }],
      targetJob: { brief: { mustHaves: [{ name: "classroom support" }] } },
    });

    await post({ section: "experience", draftId, sortId: "s1" });

    expect(aiService.inferRoleKeywords).not.toHaveBeenCalled();
    expect(promptArgs().noJd).toBeNull();
  });

  it("starts the call anyway when the lookup takes too long", async () => {
    // A call button that hangs is a worse bug than a call that is slightly less fluent.
    // REAL timers: faking them deadlocks the request, which is itself waiting on one.
    withDraft({ experience: [{ _sortId: "s1", title: "Teaching Assistant" }], targetJob: {} });
    aiService.inferRoleKeywords.mockReturnValue(new Promise(() => {}));

    const started = Date.now();
    const res = await post({ section: "experience", draftId, sortId: "s1" });

    expect(res.status).toBe(200);
    expect(promptArgs().noJd).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("starts the call anyway when the lookup fails outright", async () => {
    withDraft({ experience: [{ _sortId: "s1", title: "Teaching Assistant" }], targetJob: {} });
    aiService.inferRoleKeywords.mockRejectedValue(new Error("model down"));

    const res = await post({ section: "experience", draftId, sortId: "s1" });

    expect(res.status).toBe(200);
    expect(promptArgs().noJd).toBeNull();
  });

  it("asks for nothing when the entry has no title to ask about", async () => {
    withDraft({ experience: [{ _sortId: "s1", title: "" }], targetJob: {} });

    await post({ section: "experience", draftId, sortId: "s1" });

    expect(aiService.inferRoleKeywords).not.toHaveBeenCalled();
  });
});
