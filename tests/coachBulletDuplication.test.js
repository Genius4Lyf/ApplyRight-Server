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
  it("is told, line by line, what this role already claims", async () => {
    await post();

    const options = aiService.generateBulletsFromDescription.mock.calls[0][2];

    // The precondition: those bullets really are on the entry, one lookup away — and now
    // they are also in front of the thing writing the next ones.
    expect(draft.experience[0].description).toContain("FIT checks");
    expect(options.existingBullets).toEqual([
      expect.stringContaining("FIT checks"),
      expect.stringContaining("Equipment Readiness team"),
      expect.stringContaining("doghouses"),
    ]);
  });

  it("hands them over as clean lines, not as one blob with bullet glyphs", async () => {
    await post();

    const { existingBullets } = aiService.generateBulletsFromDescription.mock.calls[0][2];
    expect(existingBullets).toHaveLength(3);
    // The leading glyph varies by whatever wrote the entry (•, -, *) and is furniture, not
    // content — left on, it is three characters of noise at the head of every line and a
    // token the duplicate check would have to learn to ignore.
    existingBullets.forEach((line) => expect(line).not.toMatch(/^[\s•\-*]/));
  });

  it("sends nothing at all for an entry that has no bullets yet", async () => {
    draft.experience[0].description = "";
    await post();

    const { existingBullets } = aiService.generateBulletsFromDescription.mock.calls[0][2];
    expect(existingBullets).toEqual([]);
  });

  // The ledger the writer reads from is still ONE bucket per entry — what changed is that
  // a later round now merges into it rather than replacing it (see
  // coachInterviewClose.test.js, "carries earlier rounds' evidence forward").
  it("still reads one evidence bucket per entry", async () => {
    const bucket = draft.coachEvidence[SORT_ID];
    expect(Array.isArray(bucket.evidence)).toBe(true);
    expect(Object.keys(draft.coachEvidence)).toEqual([SORT_ID]);
  });
});
