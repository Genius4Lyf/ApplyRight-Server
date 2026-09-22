const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");
const { verifiedInterviewEvidence } = require("../src/controllers/coach.controller");

// WHAT HAPPENS TO A ROLE INTERVIEW THAT KEEPS GOING.
//
// Applying bullets is a checkpoint, not an ending: the user can carry on talking about the
// same role, and on a role with a lot in it that thread gets long. The question these
// cover is the one that matters — can Aria start drifting, contradicting herself, or
// claiming things nobody said, because the conversation grew?
//
// The answer has two halves, and both are load-bearing enough to pin.
//
// SHE CANNOT GROW WITHOUT BOUND. The context is a fixed sliding window of the most recent
// turns, so a long interview costs no more than a short one and nothing runs away. That is
// the good half.
//
// SHE ALSO CANNOT REMEMBER PAST IT. The window SLIDES — what leaves the top is gone. It is
// not summarised, carried forward, or pinned. So the real failure mode of a long interview
// is not invention; it is AMNESIA, and the two look completely different from the outside:
//   · she can re-ask something answered early on,
//   · and, more quietly, a TRUE thing said early can no longer be banked as evidence,
//     because every evidence item has to quote a user turn that is still in the window.
// The second one is silent — the claim is dropped, not flagged — which is exactly why it
// gets a test rather than a comment.
//
// Same harness as coachInterviewClose.test.js: models + ai.service + jwt mocked, the
// windowing and verification running for real, because those are what is under test.
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

// A conversation of `pairs` aria/user exchanges, each user turn uniquely identifiable so a
// window can be read off the result without counting.
const longThread = (pairs) => {
  const turns = [];
  for (let i = 0; i < pairs; i += 1) {
    turns.push({ who: "aria", text: `Question number ${i}?` });
    turns.push({ who: "user", text: `Answer number ${i} about the wireline unit` });
  }
  return turns;
};

const setDraft = (over = {}) => {
  const draft = {
    userId: mockUserId,
    experience: [{ _sortId: "sort-1", title: "Wireline Operator", company: "SLB" }],
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

const post = (messages, body = {}) =>
  request(app)
    .post("/api/coach/chat")
    .set("Authorization", "Bearer token")
    .send({ draftId, messages, focus, studioInterview: true, buildTurns: 3, ...body });

// What the model was actually handed.
const sentMessages = () => aiService.coachChatTurn.mock.calls[0][0].messages;

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
  aiService.coachChatTurn.mockResolvedValue({
    reply: "Got it.",
    intent: "building",
    description: "",
    evidence: [],
    requirementChecks: [],
    suggestions: [],
    exampleAnswer: "",
  });
});

describe("a long role interview cannot grow without bound", () => {
  it("hands the model a fixed window however long the thread gets", async () => {
    await post(longThread(60));

    const sent = sentMessages();
    expect(sent.length).toBeLessThanOrEqual(22);
    // The most recent turn is always there — it is the one being answered.
    expect(sent[sent.length - 1].text).toContain("Answer number 59");
  });

  it("costs the same context at turn 120 as at turn 60", async () => {
    await post(longThread(60));
    const short = sentMessages().length;

    jest.clearAllMocks();
    setDraft();
    aiService.coachChatTurn.mockResolvedValue({ reply: "Got it.", intent: "building" });
    await post(longThread(120));

    expect(sentMessages().length).toBe(short);
  });

  // THE COST OF THAT BOUND, stated out loud. Nothing summarises what falls off the top, so
  // an early answer is simply not in front of her any more. This is why she can re-ask
  // something from the start of a long interview — it is the window, not a lapse, and
  // anyone changing the size should see what they are trading.
  it("no longer carries the opening answers once the thread is long", async () => {
    await post(longThread(60));

    const sent = sentMessages();
    expect(sent.some((m) => m.text.includes("Answer number 0"))).toBe(false);
    expect(sent.some((m) => m.text.includes("Answer number 1 "))).toBe(false);
  });
});

describe("nothing can be banked that the user did not say", () => {
  const SAID = "I greased the sheaves and shackles before every rig-up";
  const turns = [
    { who: "aria", text: "What did maintenance look like?" },
    { who: "user", text: SAID },
  ];

  it("keeps a claim whose quote is really in the conversation", () => {
    const kept = verifiedInterviewEvidence(
      [{ claim: "Greased sheaves and shackles before rig-up", sourceQuote: SAID }],
      turns
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].sourceTurn).toBe(0);
  });

  it("drops a claim whose quote appears nowhere", () => {
    const kept = verifiedInterviewEvidence(
      [
        {
          claim: "Cut rig downtime by 18%",
          sourceQuote: "I cut rig downtime by 18% across the region",
        },
      ],
      turns
    );
    expect(kept).toEqual([]);
  });

  // THE SILENT ONE.
  //
  // The same TRUE thing, said too long ago. Once its turn has slid out of the window the
  // quote cannot be found, so the evidence is discarded — not flagged, not deferred,
  // discarded. From the outside this looks like Aria forgetting something the user
  // definitely told her, and it is the failure a long interview actually produces.
  it("drops a TRUE claim once its turn has slid out of the window", async () => {
    const thread = [{ who: "aria", text: "What did maintenance look like?" }, ...longThread(40)];
    thread.splice(1, 0, { who: "user", text: SAID });

    await post(thread);
    const window = sentMessages();

    // Precondition: it really was said, and it really is gone from what she was handed.
    expect(thread.some((m) => m.text === SAID)).toBe(true);
    expect(window.some((m) => m.text === SAID)).toBe(false);

    expect(
      verifiedInterviewEvidence(
        [{ claim: "Greased sheaves and shackles before rig-up", sourceQuote: SAID }],
        window
      )
    ).toEqual([]);
  });
});
