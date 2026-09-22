const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// WHY A SECOND ROUND CAN WRITE A BULLET THE ROLE ALREADY HAS.
//
// Observed on a real CV: a Wireline Field Operator role carrying 40 applied bullets, where
// #33–#38 are near-copies of #9–#16 — the same FIT-check handoff, the same fault reporting,
// the same preventive-maintenance line, written twice in slightly different words. The
// second round of the interview produced them.
//
// It is not a writing-quality problem, and no better model fixes it: the writer is never
// shown the bullets the entry already has. It is asked for N bullets from a description and
// an evidence ledger, and both of those describe only the round that just happened. Nothing
// it receives says "this role already claims the FIT-check handoff."
//
// Pinned BEFORE changing anything, so the reading is proved rather than assumed, and so the
// fix has a red/green target to move.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const draftId = "60c72b2f9b1d8b2bad6e1a22";
const SORT_ID = "sort-1";

// What round one already put on the role. These are the real bullets from the CV above.
const EXISTING = [
  "• Handed off serviced equipment to specialists for FIT checks, ensuring units and tools were verified ready before the next job.",
  "• Identified and reported equipment faults immediately through the company-approved system, enabling timely follow-up by the Equipment Readiness team.",
  "• Performed preventive and first-line maintenance on wireline units, wireline tools, doghouses, rigging-up equipment and TLC tools after every field operation.",
].join("\n");

const detail = (text) => ({ text, evidenceIds: ["ev_1"], requirementIds: [] });

const buildDraft = (over = {}) => ({
  _id: draftId,
  userId: { toString: () => mockUserId },
  experience: [
    { _sortId: SORT_ID, title: "Wireline Field Operator", company: "SLB", description: EXISTING },
  ],
  projects: [],
  coachEvidence: {
    [SORT_ID]: {
      evidence: [
        {
          id: "ev_1",
          claim: "Handed equipment to specialists for FIT checks",
          sourceQuote: "I handed the equipment to the specialist for FIT checks",
        },
      ],
    },
  },
  genState: {},
  markModified: jest.fn(),
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

let draft;

const post = (body = {}) =>
  request(app)
    .post("/api/coach/generate-bullets")
    .set("Authorization", "Bearer token")
    .send({
      draftId,
      section: "experience",
      sortId: SORT_ID,
      // The SECOND round's description — the user going over the same ground again,
      // which is exactly what happens when she cannot see what is already there.
      description: "I handed the equipment to the specialist for FIT checks after every job.",
      count: 3,
      ...body,
    });

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: mockUserId });
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({
      _id: mockUserId,
      id: mockUserId,
      credits: 50,
      plan: "free",
      subscription: undefined,
      save: jest.fn().mockResolvedValue(true),
    }),
  });
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Transaction.create.mockResolvedValue({});
  SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
  class AIUnavailableError extends Error {}
  aiService.AIUnavailableError = AIUnavailableError;
  draft = buildDraft();
  DraftCV.findById.mockResolvedValue(draft);
  aiService.generateBulletsFromDescription.mockResolvedValue([detail("A bullet")]);
});

describe("the bullet writer and the bullets the role already has", () => {
  it("is never told what this role already claims", async () => {
    await post();

    const [description, , options] = aiService.generateBulletsFromDescription.mock.calls[0];
    const everythingItSees = JSON.stringify({ description, options });

    // The precondition: those bullets really are on the entry, one lookup away.
    expect(draft.experience[0].description).toContain("FIT checks");
    // And none of them reach the writer, under any key.
    expect(everythingItSees).not.toContain("verified ready before the next job");
    expect(everythingItSees).not.toContain("Equipment Readiness team");
    expect(everythingItSees).not.toContain("doghouses");
  });

  it("carries no instruction to avoid repeating them", async () => {
    await post();

    const options = aiService.generateBulletsFromDescription.mock.calls[0][2];
    // Any future fix will add a key for this. Named here so the absence is a decision on
    // the record rather than an oversight nobody wrote down.
    expect(options.existingBullets).toBeUndefined();
    expect(options.avoid).toBeUndefined();
  });

  // The other half of the same blindness, on the interview side: each round REPLACES the
  // role's verified notes rather than adding to them, so what round one proved is not
  // there for round two to build on either.
  it("keeps only the most recent round's evidence on the entry", async () => {
    // The route above does not write evidence; this pins the SHAPE the writer reads from,
    // which is a single bucket per sortId rather than an accumulating list.
    const bucket = draft.coachEvidence[SORT_ID];
    expect(Array.isArray(bucket.evidence)).toBe(true);
    expect(Object.keys(draft.coachEvidence)).toEqual([SORT_ID]);
  });
});
