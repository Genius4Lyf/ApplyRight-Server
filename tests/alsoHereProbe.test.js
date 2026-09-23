const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");
// The brief is only served from the draft when its hash matches the JD text — otherwise
// resolveDraftBrief rebuilds it through the (mocked) AI and gets nothing back.
const { briefHashFor } = require("../src/controllers/coach.controller");

// "I DID THIS HERE TOO" — the same requirement, asked about THIS entry.
//
// Coverage is computed across the WHOLE CV, so a requirement proved at one job is green
// everywhere and Aria never raises it again. That is right for the automatic behaviour —
// a CV covers the posting as a whole — but it left the most recent role, the one a
// recruiter reads first, with no way to claim it even when the user wanted to.
//
// The obvious implementation was to unhide the existing tap and let it run the
// cross-history hunt. THAT WOULD HAVE BEEN A DESTRUCTIVE BUG, and it is what most of this
// file exists to prevent. The hunt files evidence under whichever entry the user names
// (its own comment: "usually NOT the entry this conversation started from") and, on a
// clear no, writes a CV-WIDE decline that silences the requirement on every surface. So
// tapping "I did this here too" and answering "actually, not at this job" would have
// deleted a requirement the user genuinely holds somewhere else — unrecoverably, from
// the user's point of view.
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
const focus = { section: "experience", sortId: "sort-new" };

const JD = "Raise permits to work for hazardous tasks. Maintain haulage equipment.";
const SAID = "I raised the permits to work for the high voltage jobs here";
const messages = [
  { who: "aria", text: "Tell me what you did at Matrix." },
  { who: "user", text: SAID },
];

const BRIEF = {
  role: "Haulage Maintenance Officer",
  mustHaves: [{ name: "Permit-to-Work", importance: "must_have" }],
  requirements: [
    {
      id: "req_ptw",
      name: "Permit-to-Work",
      type: "method",
      priority: "must_have",
      aliases: ["PTW"],
      proofSignals: ["permit", "isolation"],
    },
  ],
};

let draft;

const setDraft = (over = {}) => {
  draft = {
    userId: mockUserId,
    // Permit-to-Work is ALREADY covered — by the older role, whose bullets say so.
    experience: [
      {
        _sortId: "sort-old",
        title: "Wireline Field Operator",
        company: "SLB",
        description: "• Raised permits to work for non-routine and hazardous tasks",
      },
      {
        _sortId: "sort-new",
        title: "Haulage Maintenance Officer",
        company: "Matrix",
        description: "",
      },
    ],
    projects: [],
    skills: [],
    education: [],
    professionalSummary: "",
    targetJob: {
      title: "Haulage Maintenance Officer",
      description: JD,
      brief: BRIEF,
      briefHash: briefHashFor(JD),
    },
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

const post = (body = {}) =>
  request(app)
    .post("/api/coach/chat")
    .set("Authorization", "Bearer token")
    .send({ draftId, messages, focus, studioInterview: true, buildTurns: 3, ...body });

const sent = () => aiService.coachChatTurn.mock.calls[0][0];

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
  });
  aiService.resolveCareerStage.mockReturnValue("experienced");
  aiService.cvDigest.mockReturnValue("digest");
  // Restored on the automock, which flattens these arrays to empty — without them
  // verifyProbeResult rejects every level and the decline path below can never run, so
  // the test guarding it would pass for the wrong reason.
  aiService.HUNT_LEVELS = ["regular", "basic", "coursework", "encountered", "never"];
  aiService.HUNT_LEVELS_ADDABLE = ["regular", "basic", "coursework"];
});

describe("tapping a covered requirement on a new role", () => {
  it("raises it this turn, even though it is covered everywhere else", async () => {
    await post({ probe: { requirementId: "req_ptw", scope: "entry" } });

    const call = sent();
    expect(call.requiredProbe).toMatchObject({ id: "req_ptw", name: "Permit-to-Work" });
    // It also joins the turn's requirement list — which is what lets the answer be LINKED
    // back to this requirement. Without that the reply banks with no connection to it,
    // this role gets no credit on the checklist, and the tick keeps naming the older job.
    expect(call.openMustHaves.map((r) => r.id)).toContain("req_ptw");
  });

  it("tells the prompt it is already covered, so she does not open as if it were new", async () => {
    await post({ probe: { requirementId: "req_ptw", scope: "entry" } });
    expect(sent().requiredProbe.alreadyCovered).toBe(true);
  });

  // THE FOOTGUN. The cross-history hunt must not run for an entry-scoped tap — it is the
  // thing that files evidence elsewhere and writes CV-wide declines.
  it("never runs the cross-history hunt", async () => {
    await post({ probe: { requirementId: "req_ptw", scope: "entry" } });
    expect(sent().probe).toBeFalsy();
  });

  // The consequence, stated on its own because it is the one that destroys data.
  it("writes NO decline when the user says it was not part of this job", async () => {
    aiService.coachChatTurn.mockResolvedValue({
      reply: "Understood — it stays on your CV from the other role.",
      intent: "building",
      description: "",
      evidence: [],
      requirementChecks: [],
      // What the hunt path would have acted on. Entry-scoped, it must be inert.
      probeResult: { requirementId: "req_ptw", name: "Permit-to-Work", level: "never" },
    });

    // mode:"build" is the UNEVIDENCED decline shortcut — the fastest route the hunt has
    // to writing a permanent, CV-wide "never ask again". If an entry-scoped tap can reach
    // it, one wrong answer erases a requirement the user holds at another job.
    const res = await post({
      probe: { requirementId: "req_ptw", scope: "entry", mode: "build" },
    });

    expect(res.status).toBe(200);
    expect(draft.skillDeclines).toEqual([]);
    expect(draft.requirementProbes).toEqual([]);
  });

  // A clear "no" is still honoured everywhere and permanently — the new door does not
  // become the way a refused requirement comes back.
  it("refuses to raise a requirement the user has already declined", async () => {
    setDraft({
      skillDeclines: [{ requirementId: "req_ptw", name: "Permit-to-Work", level: "never" }],
    });

    await post({ probe: { requirementId: "req_ptw", scope: "entry" } });

    expect(sent().requiredProbe?.alreadyCovered).toBeFalsy();
    expect(sent().probe).toBeFalsy();
  });

  it("ignores an unknown requirement id rather than inventing one", async () => {
    await post({ probe: { requirementId: "req_nope", scope: "entry" } });
    expect(sent().requiredProbe?.alreadyCovered).toBeFalsy();
  });

  // Unscoped taps are unchanged: an OPEN requirement still runs the hunt, which is what
  // finds it elsewhere in a history the user had forgotten about.
  it("leaves the ordinary hunt alone when no scope is given", async () => {
    await post({ probe: { requirementId: "req_ptw" } });
    expect(sent().probe).toMatchObject({ requirementId: "req_ptw" });
  });
});
