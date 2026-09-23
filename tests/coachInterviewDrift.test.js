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

// SHE CAN SEE WHAT THE LAST ROUND PRODUCED.
//
// The window above bounds the CONVERSATION; it says nothing about the CV. A second round
// on the same role opens on a blank transcript (StudioChat pushes a fresh `pinrole` after
// bullets are applied), and the CV digest travelling with it compresses the whole role to
// 140 characters — about one truncated line on a role with forty bullets. So Aria asked
// again for what she already had, and the writer, told the same nothing, wrote it again.
describe("what a focused interview knows about the entry itself", () => {
  const withBullets = (description) =>
    setDraft({
      experience: [{ _sortId: "sort-1", title: "Wireline Operator", company: "SLB", description }],
    });

  it("hands over the bullets this entry already carries", async () => {
    withBullets(
      "• Handed off serviced equipment to specialists for FIT checks\n" +
        "• Reported equipment faults through the company system"
    );

    await post(longThread(2));

    expect(aiService.coachChatTurn.mock.calls[0][0].entryBullets).toEqual([
      "Handed off serviced equipment to specialists for FIT checks",
      "Reported equipment faults through the company system",
    ]);
  });

  it("strips the bullet glyph, which is furniture rather than content", async () => {
    withBullets("- dash style\n* star style\n• dot style");

    await post(longThread(2));

    expect(aiService.coachChatTurn.mock.calls[0][0].entryBullets).toEqual([
      "dash style",
      "star style",
      "dot style",
    ]);
  });

  it("sends none for an entry with nothing on it yet", async () => {
    withBullets("");

    await post(longThread(2));

    expect(aiService.coachChatTurn.mock.calls[0][0].entryBullets).toEqual([]);
  });

  // Only a FOCUSED turn is about one entry. A general chat question has no entry to be
  // about, and pushing one role's bullets into it would narrow an open question.
  it("sends none on an unfocused turn", async () => {
    withBullets("• Handed off serviced equipment for FIT checks");

    await request(app)
      .post("/api/coach/chat")
      .set("Authorization", "Bearer token")
      .send({ draftId, messages: longThread(2), currentStepId: "history" });

    expect(aiService.coachChatTurn.mock.calls[0][0].entryBullets).toEqual([]);
  });
});

// HOW LONG THE INTERVIEW RUNS IS THE USER'S CHOICE.
//
// Reported: "I was being interviewed a lot." Not a defect — the prompt says not to wrap up
// while a plausibly relevant requirement is unexplored, and a model that follows
// instructions more literally keeps going for longer. But ten turns is a long time to be
// asked questions, and which side of that trade someone wants is not ours to guess.
//
// The setting already existed and was already ON SCREEN: the chip under the composer reads
// "Thorough · Direct", it is saved on the account, and it governed CALLS ONLY. Someone
// could set it, watch it sit there through an entire typed interview, and reasonably
// wonder what it was for. This is that control finally meaning what it says.
//
// TWO halves, and the second is what makes it feel different rather than merely shorter:
// the cap stops the interview, the PROMPT changes how she conducts it. A cap alone gags
// her mid-flow at turn six; the prompt makes her aim to be finished by then.
describe("thorough or quick, as the user set it", () => {
  const ask = (body) => post(longThread(3), body);
  const sent = () => aiService.coachChatTurn.mock.calls[0][0];

  it("passes the choice through to the interviewer", async () => {
    await ask({ depth: "quick" });
    expect(sent().depth).toBe("quick");
  });

  it("defaults to thorough, which is what it has always been", async () => {
    await ask({});
    expect(sent().depth).toBe("thorough");
  });

  // Never trusted from the client: an unlisted value must not reach a prompt, and must not
  // lengthen an interview nobody asked to lengthen.
  it("falls back to thorough on a value it does not recognise", async () => {
    await ask({ depth: "exhaustive" });
    expect(sent().depth).toBe("thorough");
  });

  // The cap is the backstop. `mustFinish` is what the server sets when the cap is reached,
  // and it forces a draft out of whatever is there — so the two depths have to hit it at
  // different turn counts or the setting is decoration.
  it("wraps a quick interview up at six turns", async () => {
    await ask({ depth: "quick", buildTurns: 6 });
    expect(sent().mustFinish).toBe(true);
  });

  it("lets a thorough interview keep going at six", async () => {
    await ask({ depth: "thorough", buildTurns: 6 });
    expect(sent().mustFinish).toBe(false);
  });

  it("still stops a thorough interview at ten", async () => {
    await ask({ depth: "thorough", buildTurns: 10 });
    expect(sent().mustFinish).toBe(true);
  });
});
