const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// Mocks: models + ai.service + jwt. subscription.service is intentionally NOT mocked
// so the REAL chatAllowance/commitChatTurn/chargeOrSkip run against the mocked User/
// Transaction — proving the smart-per-message charge (or its absence) for real. The AI
// classifier is stubbed so we can drive each intent path deterministically.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const draftId = "60c72b2f9b1d8b2bad6e1a22";
const today = new Date().toISOString().slice(0, 10);
const focus = { section: "experience", sortId: "sort-1" };
const buildMsgs = (text) => [
  { who: "aria", text: "Tell me one thing you did in this role." },
  { who: "user", text },
];

describe("POST /api/coach/chat — smart per-message charging", () => {
  let mockUser;

  const setUser = (over = {}) => {
    mockUser = {
      _id: mockUserId,
      id: mockUserId,
      email: "candidate@example.com",
      credits: 5,
      ariaChat: { date: today, count: 0 },
      save: jest.fn().mockResolvedValue(true),
      ...over,
    };
    // Both `protect` and the handler call User.findById(id).select(...).
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(mockUser) });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setUser();
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 }); // atomic decrement succeeds
    Transaction.create.mockResolvedValue({});
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    // A draft owned by the user, one experience entry, NO target JD (so resolveDraftBrief
    // returns null without touching the AI).
    DraftCV.findById.mockResolvedValue({
      userId: mockUserId,
      experience: [{ _sortId: "sort-1", title: "Wireline Operator", company: "Schlumberger" }],
      projects: [],
      skills: [],
      professionalSummary: "",
      targetJob: { title: "", description: "" },
    });
  });

  const post = (body) =>
    request(app).post("/api/coach/chat").set("Authorization", "Bearer mock-token").send(body);

  it("focused + BUILDING → free (no charge, allowance untouched)", async () => {
    aiService.coachChatTurn.mockResolvedValue({
      reply: "Nice — how many jobs a day roughly?",
      intent: "building",
      description: "",
    });

    const res = await post({ draftId, currentStepId: "history", focus, messages: buildMsgs("I operated wireline tools downhole") });

    expect(res.statusCode).toBe(200);
    expect(res.body.intent).toBe("building");
    expect(res.body.charged).toBe(false);
    expect(res.body.readyToDraft).toBe(false);
    // FREE: nothing charged, counter NOT bumped.
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(mockUser.save).not.toHaveBeenCalled();
    expect(res.body.freeRemaining).toBe(15); // 15 - used(0), unchanged
  });

  it("focused + READY → free, description + readyToDraft populated", async () => {
    aiService.coachChatTurn.mockResolvedValue({
      reply: "Love it — I've got what I need ✍️",
      intent: "ready",
      description: "Operated wireline tools downhole to log and evaluate well formations.",
    });

    const res = await post({ draftId, currentStepId: "history", focus, messages: buildMsgs("we cut rig time by two days") });

    expect(res.statusCode).toBe(200);
    expect(res.body.intent).toBe("ready");
    expect(res.body.readyToDraft).toBe(true);
    expect(res.body.description).toMatch(/wireline/i);
    expect(res.body.charged).toBe(false);
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(mockUser.save).not.toHaveBeenCalled();
  });

  it("focused + ANSWER (general Q) in the free window → spends a free chat (counter drops, no credit)", async () => {
    setUser({ credits: 5, ariaChat: { date: today, count: 3 } });
    aiService.coachChatTurn.mockResolvedValue({
      reply: "Aim for 3–4 tight sentences.",
      intent: "answer",
      description: "",
    });

    const res = await post({ draftId, currentStepId: "history", focus, messages: buildMsgs("what's a good CV summary length?") });

    expect(res.statusCode).toBe(200);
    expect(res.body.intent).toBe("answer");
    expect(res.body.charged).toBe(false); // still inside the free 15/day
    expect(res.body.freeRemaining).toBe(11); // 15 - (3+1)
    // A free chat was consumed (counter bumped, saved) — but NO credit charged.
    expect(mockUser.save).toHaveBeenCalledTimes(1);
    expect(mockUser.ariaChat).toEqual({ date: today, count: 4 });
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("focused + ANSWER past the free allowance → charges 1 credit (real spendCredits)", async () => {
    setUser({ credits: 5, ariaChat: { date: today, count: 15 } });
    aiService.coachChatTurn.mockResolvedValue({ reply: "Keep it to 3–4 lines.", intent: "answer", description: "" });

    const res = await post({ draftId, currentStepId: "history", focus, messages: buildMsgs("how long should my summary be?") });

    expect(res.statusCode).toBe(200);
    expect(res.body.intent).toBe("answer");
    expect(res.body.charged).toBe(true);
    expect(res.body.freeRemaining).toBe(0);
    // The REAL charge ran: wallet decrement + a Transaction row.
    expect(User.updateOne).toHaveBeenCalled();
    expect(Transaction.create).toHaveBeenCalledTimes(1);
  });

  it("no focus → forced 'answer', metered like /coach/ask (free window consumes a chat)", async () => {
    setUser({ credits: 5, ariaChat: { date: today, count: 2 } });
    // Even if the model said 'building', no focus forces 'answer'.
    aiService.coachChatTurn.mockResolvedValue({ reply: "Lead with a strong verb.", intent: "building", description: "" });

    const res = await post({ draftId, currentStepId: "history", messages: buildMsgs("how do I start a bullet?") });

    expect(res.statusCode).toBe(200);
    expect(res.body.intent).toBe("answer");
    expect(res.body.freeRemaining).toBe(12); // 15 - (2+1)
    expect(mockUser.save).toHaveBeenCalledTimes(1);
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("out of allowance + no credits: focused BUILDING still works FREE", async () => {
    setUser({ credits: 0, ariaChat: { date: today, count: 15 } });
    aiService.coachChatTurn.mockResolvedValue({ reply: "And what changed because of it?", intent: "building", description: "" });

    const res = await post({ draftId, currentStepId: "history", focus, messages: buildMsgs("I fixed the tool string") });

    expect(res.statusCode).toBe(200);
    expect(res.body.intent).toBe("building");
    expect(res.body.charged).toBe(false);
    expect(typeof res.body.reply).toBe("string");
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("out of allowance + no credits: focused ANSWER → 402 CHAT_LIMIT_REACHED, reply NOT leaked", async () => {
    setUser({ credits: 0, ariaChat: { date: today, count: 15 } });
    aiService.coachChatTurn.mockResolvedValue({ reply: "SECRET ANSWER", intent: "answer", description: "" });

    const res = await post({ draftId, currentStepId: "history", focus, messages: buildMsgs("what font should I use?") });

    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe("CHAT_LIMIT_REACHED");
    expect(res.body.reply).toBeUndefined(); // no reply leaked to a user who can't pay
    expect(res.body.freeRemaining).toBe(0);
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("400 when the last message is not the user's turn", async () => {
    const res = await post({
      draftId,
      currentStepId: "history",
      focus,
      messages: [{ who: "user", text: "hi" }, { who: "aria", text: "hey" }],
    });
    expect(res.statusCode).toBe(400);
    expect(aiService.coachChatTurn).not.toHaveBeenCalled();
  });

  it("404 when the focused entry is gone", async () => {
    aiService.coachChatTurn.mockResolvedValue({ reply: "x", intent: "building", description: "" });
    const res = await post({
      draftId,
      currentStepId: "history",
      focus: { section: "experience", sortId: "does-not-exist" },
      messages: buildMsgs("I did the thing"),
    });
    expect(res.statusCode).toBe(404);
    expect(aiService.coachChatTurn).not.toHaveBeenCalled();
  });

  describe("career stage threading", () => {
    beforeEach(() => {
      aiService.coachChatTurn.mockResolvedValue({ reply: "ok", intent: "building", description: "" });
      // Real resolver behaviour: explicit valid stage wins, else infer from the draft.
      aiService.resolveCareerStage.mockImplementation(({ stage, draft }) =>
        ["experienced", "grad", "changer"].includes(stage)
          ? stage
          : (draft?.experience || []).some((e) => e?.title || e?.company)
          ? "experienced"
          : "grad"
      );
    });

    it("forwards an explicit stage from the request to coachChatTurn", async () => {
      await post({
        draftId,
        currentStepId: "history",
        focus,
        stage: "grad",
        messages: buildMsgs("In my final-year project I built a booking app"),
      });
      expect(aiService.resolveCareerStage).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "grad" })
      );
      expect(aiService.coachChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "grad" })
      );
    });

    it("resolves the stage from the draft when none is sent (inference fallback)", async () => {
      // The seeded draft has a real experience entry → inference should yield 'experienced'.
      await post({
        draftId,
        currentStepId: "history",
        focus,
        messages: buildMsgs("I operated wireline tools downhole"),
      });
      expect(aiService.coachChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "experienced" })
      );
    });
  });

  describe("model selection", () => {
    const paidSub = {
      tier: "plus",
      status: "active",
      expiresAt: new Date(Date.now() + 86400000),
      creditsRemaining: 100,
    };

    it("threads the resolved model id into coachChatTurn (default when none picked)", async () => {
      aiService.coachChatTurn.mockResolvedValue({ reply: "hi", intent: "building", description: "" });
      await post({ draftId, currentStepId: "history", focus, messages: buildMsgs("I did X") });
      // The turn RUNS on the selected model — default gpt-4o-mini here — via meta.modelId.
      expect(aiService.coachChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ meta: expect.objectContaining({ modelId: "gpt-4o-mini" }) })
      );
    });

    it("a focused BUILD-WITH turn stays FREE even on a flagship model", async () => {
      setUser({ credits: 5, ariaChat: { date: today, count: 15 } }); // past the free daily pool
      aiService.coachChatTurn.mockResolvedValue({ reply: "and then?", intent: "building", description: "" });

      const res = await post({
        draftId,
        currentStepId: "history",
        focus,
        model: "gpt-5", // flagship
        messages: buildMsgs("I operated the tools"),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.charged).toBe(false); // building never charges, regardless of model
      expect(Transaction.create).not.toHaveBeenCalled();
      // …and it still ran on the picked flagship model.
      expect(aiService.coachChatTurn).toHaveBeenCalledWith(
        expect.objectContaining({ meta: expect.objectContaining({ modelId: "gpt-5" }) })
      );
    });

    it("a metered general answer on FLAGSHIP charges the flagship cost, even on a paid plan", async () => {
      setUser({ credits: 5, subscription: paidSub, ariaChat: { date: today, count: 15 } });
      aiService.coachChatTurn.mockResolvedValue({ reply: "here you go", intent: "answer", description: "" });

      const res = await post({
        draftId,
        currentStepId: "history",
        model: "gpt-5", // flagship — no focus → forced 'answer' (metered)
        messages: buildMsgs("how long should my summary be?"),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.charged).toBe(true); // flagship ALWAYS meters, even for paid
      expect(User.updateOne).toHaveBeenCalled();
      expect(Transaction.create).toHaveBeenCalledTimes(1);
    });

    it("a metered general answer on LIGHT is FREE on an active paid plan", async () => {
      setUser({ credits: 5, subscription: paidSub, ariaChat: { date: today, count: 15 } });
      aiService.coachChatTurn.mockResolvedValue({ reply: "sure", intent: "answer", description: "" });

      const res = await post({
        draftId,
        currentStepId: "history",
        // no model → default light; past the free pool, but paid → unlimited light.
        messages: buildMsgs("what's a good CV length?"),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.charged).toBe(false); // light is included on paid plans
      expect(Transaction.create).not.toHaveBeenCalled();
    });
  });
});
