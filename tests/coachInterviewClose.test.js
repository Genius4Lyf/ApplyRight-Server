const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// The moment a focused interview CLOSES — two bugs that quietly corrupted paid output.
//
// Same harness as coachChat.test.js: models + ai.service + jwt mocked, everything else
// (verifiedInterviewEvidence, the ledger merge, descriptionFromEvidence) running for real,
// because those are exactly what is under test.
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

// The user's exact words. `verifiedInterviewEvidence` refuses any sourceQuote that does not
// appear verbatim in a real user turn, so the quote below and this turn must match.
const SAID = "I ran cased-hole logging on thirty wells and wrote the client report";
const messages = [
  { who: "aria", text: "Tell me one thing you did in this role." },
  { who: "user", text: SAID },
];

let draft;

const setDraft = (over = {}) => {
  draft = {
    userId: mockUserId,
    experience: [{ _sortId: "sort-1", title: "Wireline Operator", company: "Schlumberger" }],
    projects: [],
    skills: [],
    education: [],
    professionalSummary: "",
    targetJob: { title: "", description: "" },
    coachEvidence: {},
    requirementProbes: [],
    skillDeclines: [],
    markModified: jest.fn(),
    save: jest.fn().mockResolvedValue(true),
    ...over,
  };
  DraftCV.findById.mockResolvedValue(draft);
  return draft;
};

const post = (body) =>
  request(app)
    .post("/api/coach/chat")
    .set("Authorization", "Bearer token")
    .send({ draftId, messages, focus, studioInterview: true, ...body });

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: mockUserId });
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({
      _id: mockUserId,
      id: mockUserId,
      credits: 50,
      ariaChat: { date: today, count: 0 },
      ariaBuild: { date: today, count: 0 },
      save: jest.fn().mockResolvedValue(true),
    }),
  });
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Transaction.create.mockResolvedValue({});
  SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
  setDraft();
});

describe("a capped interview still returns a usable description", () => {
  it("assembles one from verified evidence when the model returns none", async () => {
    // The bug: the wrap-up is forced off `readyToDraft`, but the response keyed off
    // `intent`. A model that answered 'building' on the cap turn produced
    // readyToDraft:true with description:"" — and both clients then joined the raw user
    // turns into a generation the user PAYS for.
    aiService.coachChatTurn.mockResolvedValue({
      reply: "Got it.",
      intent: "building",
      description: "",
      evidence: [{ claim: "Ran cased-hole logging on thirty wells", sourceQuote: SAID }],
      requirementChecks: [],
      suggestions: [],
      exampleAnswer: "",
    });

    // buildTurns at the Studio cap (10) forces mustFinish.
    const res = await post({ buildTurns: 10 });

    expect(res.status).toBe(200);
    expect(res.body.readyToDraft).toBe(true);
    expect(res.body.description).toContain("cased-hole logging on thirty wells");
    expect(res.body.description).not.toBe("");
  });

  it("prefers the model's own description when it gives one", async () => {
    aiService.coachChatTurn.mockResolvedValue({
      reply: "Got it.",
      intent: "ready",
      description: "I ran cased-hole logging and owned the client reporting.",
      evidence: [{ claim: "Ran cased-hole logging on thirty wells", sourceQuote: SAID }],
      requirementChecks: [],
    });

    const res = await post({ buildTurns: 3 });

    expect(res.body.description).toBe("I ran cased-hole logging and owned the client reporting.");
  });

  it("stays empty on an ordinary mid-interview turn", async () => {
    aiService.coachChatTurn.mockResolvedValue({
      reply: "What tools did you use?",
      intent: "building",
      description: "",
      evidence: [],
      requirementChecks: [],
      suggestions: [],
      exampleAnswer: "",
    });

    const res = await post({ buildTurns: 2 });

    expect(res.body.readyToDraft).toBe(false);
    expect(res.body.description).toBe("");
  });
});

describe("re-interviewing a role keeps what the hunt banked there", () => {
  it("carries hunt evidence forward and replaces the interview's own", async () => {
    // The cross-history hunt files its confirmations into the SAME bucket, stamped
    // fromHunt. Replacing the bucket wholesale silently un-proved a requirement the user
    // had already been asked about separately and confirmed.
    const hunted = {
      id: "ev_hunted00001",
      claim: "Used Excel to build the daily report",
      sourceQuote: "I built the daily report in Excel",
      requirementIds: ["req_excel"],
      fromHunt: true,
    };
    setDraft({ coachEvidence: { "sort-1": { evidence: [hunted], requirementChecks: [] } } });

    aiService.coachChatTurn.mockResolvedValue({
      reply: "Got it.",
      intent: "ready",
      description: "Ran logging.",
      evidence: [{ claim: "Ran cased-hole logging on thirty wells", sourceQuote: SAID }],
      requirementChecks: [],
    });

    const res = await post({ buildTurns: 3 });

    expect(res.status).toBe(200);
    const saved = draft.coachEvidence["sort-1"].evidence;
    const claims = saved.map((e) => e.claim);
    expect(claims).toContain("Ran cased-hole logging on thirty wells");
    expect(claims).toContain("Used Excel to build the daily report");
    expect(saved.find((e) => e.fromHunt)).toBeTruthy();
  });

  it("does not duplicate a hunt item the interview re-found", async () => {
    // Both write sites derive `id` the same way, so the same quote+claim collides.
    aiService.coachChatTurn.mockResolvedValue({
      reply: "Got it.",
      intent: "ready",
      description: "Ran logging.",
      evidence: [{ claim: "Ran cased-hole logging on thirty wells", sourceQuote: SAID }],
      requirementChecks: [],
    });

    // First pass writes the interview evidence; capture the id it minted.
    await post({ buildTurns: 3 });
    const firstPass = draft.coachEvidence["sort-1"].evidence;
    expect(firstPass).toHaveLength(1);

    // Now pretend the hunt had banked that very same finding, then re-interview.
    setDraft({
      coachEvidence: {
        "sort-1": { evidence: [{ ...firstPass[0], fromHunt: true }], requirementChecks: [] },
      },
    });
    await post({ buildTurns: 3 });

    expect(draft.coachEvidence["sort-1"].evidence).toHaveLength(1);
  });

  it("replaces stale interview evidence rather than piling it up", async () => {
    setDraft({
      coachEvidence: {
        "sort-1": {
          evidence: [
            { id: "ev_old0000001", claim: "Something from an earlier round", sourceQuote: "x" },
          ],
          requirementChecks: [],
        },
      },
    });

    aiService.coachChatTurn.mockResolvedValue({
      reply: "Got it.",
      intent: "ready",
      description: "Ran logging.",
      evidence: [{ claim: "Ran cased-hole logging on thirty wells", sourceQuote: SAID }],
      requirementChecks: [],
    });

    await post({ buildTurns: 3 });

    const claims = draft.coachEvidence["sort-1"].evidence.map((e) => e.claim);
    expect(claims).not.toContain("Something from an earlier round");
    expect(claims).toContain("Ran cased-hole logging on thirty wells");
  });
});

describe("what the model is actually handed", () => {
  it("passes the scan, the recruiter flags and the CV digest through to the prompt", async () => {
    // The link between "the blocks build correctly" (coachContextBlocks.test.js) and "the
    // blocks reach the model". All three come off a draft the controller already had in
    // memory — no extra query, no extra AI call.
    setDraft({
      studioScan: { fitScore: 61, scannedAt: "2026-09-01T10:00:00.000Z", sections: [] },
      experience: [
        {
          _sortId: "sort-1",
          title: "Wireline Operator",
          company: "Schlumberger",
          description: "• Responsible for rig-up and rig-down",
        },
      ],
    });
    aiService.coachChatTurn.mockResolvedValue({
      reply: "Noted.",
      intent: "building",
      description: "",
      evidence: [],
      requirementChecks: [],
      suggestions: [],
      exampleAnswer: "",
    });

    await post({ buildTurns: 1 });

    const args = aiService.coachChatTurn.mock.calls.at(-1)[0];
    expect(args.scan).toEqual(expect.objectContaining({ fitScore: 61 }));
    // detectRedFlags runs for real — "Responsible for" is a passive opener.
    expect(args.redFlags.some((f) => /passive/i.test(f.label))).toBe(true);
    // And the digest replaced the counts-only summary.
    expect(aiService.cvDigest).toHaveBeenCalledWith(draft, "");
  });
});
