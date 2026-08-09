const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// Models + ai.service + jwt mocked; subscription.service and modelSelection are REAL, so
// the actual availableCredits/spendCredits/resolveForAction run against the mocked
// User/Transaction. That is what makes "does NOT charge" a real assertion about the
// charge choreography rather than a test of our own stub. Mirrors studioScan.test.js.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const draftId = "60c72b2f9b1d8b2bad6e1a22";
const SORT_ID = "role-1";

const buildDraft = (over = {}) => ({
  _id: draftId,
  userId: { toString: () => mockUserId },
  title: "Ernest CV — Backend Engineer",
  experience: [
    {
      _sortId: SORT_ID,
      title: "Engineer",
      company: "Acme",
      description: "• Cut latency\n• Shipped 3 services",
    },
    { _sortId: "role-2", title: "Junior Engineer", company: "Beta", description: "• Did things" },
  ],
  projects: [{ _sortId: "proj-1", title: "Pipeline", description: "• Built an ETL job" }],
  targetJob: {
    title: "Backend Engineer",
    description: "Backend engineer strong in Python and SQL on AWS.",
    brief: { mustHaves: [{ name: "Python" }], niceToHaves: [{ name: "AWS" }] },
  },
  // Phase 1 scopes gaps PER SECTION; the controller must read this row, not the CV-wide
  // missing-skills list.
  studioScan: {
    sections: [
      { key: "experience", missingKeywords: ["AWS", "SQL"] },
      { key: "skills", missingKeywords: ["Docker"] },
    ],
  },
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

const ROW_CHANGED = {
  before: "• Cut latency",
  after: "• Cut API latency 40% by adding SQL query caching",
  changed: true,
  blocked: false,
  blockedReason: null,
};
const ROW_UNCHANGED = {
  before: "• Shipped 3 services",
  after: "• Shipped 3 services",
  changed: false,
  blocked: false,
  blockedReason: null,
};
const ROW_BLOCKED = {
  before: "• Shipped 3 services",
  after: null,
  changed: false,
  blocked: true,
  blockedReason: "a number or scale",
};

describe("POST /api/studio/rewrite-role", () => {
  let mockUser;
  let draft;

  const setUser = (over = {}) => {
    mockUser = {
      _id: mockUserId,
      id: mockUserId,
      credits: 50,
      plan: "free",
      subscription: undefined,
      save: jest.fn().mockResolvedValue(true),
      ...over,
    };
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(mockUser) });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setUser();
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Transaction.create.mockResolvedValue({});
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    class AIUnavailableError extends Error {}
    aiService.AIUnavailableError = AIUnavailableError;
    aiService.resolveTextModel.mockReturnValue("gpt-4o-mini");
    aiService.buildRoleBrief?.mockResolvedValue?.(null);
    aiService.rewriteRoleBullets.mockResolvedValue([ROW_CHANGED, ROW_UNCHANGED]);
    draft = buildDraft();
    DraftCV.findById.mockResolvedValue(draft);
  });

  const post = (body = {}) =>
    request(app)
      .post("/api/studio/rewrite-role")
      .set("Authorization", "Bearer token")
      .send({ draftId, section: "experience", sortId: SORT_ID, ...body });

  it("charges REWRITE_ROLE once a bullet actually changed", async () => {
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.charged).toBe(true);
    expect(res.body.cost).toBe(1); // light tier
    expect(Transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rewrite_role" })
    );
    expect(User.updateOne).toHaveBeenCalled();
  });

  it("passes the SECTION's own scoped gaps and the entry's existing bullets", async () => {
    await post();

    expect(aiService.rewriteRoleBullets).toHaveBeenCalledWith(
      expect.objectContaining({
        bullets: ["Cut latency", "Shipped 3 services"],
        section: "experience",
        // The experience row's gaps — NOT the skills row's Docker.
        missingKeywords: ["AWS", "SQL"],
      })
    );
  });

  it("does NOT charge when every row comes back unchanged — there was no work", async () => {
    aiService.rewriteRoleBullets.mockResolvedValue([ROW_UNCHANGED, ROW_UNCHANGED]);

    const res = await post();

    // Still a SUCCESS: "already strong for this job" is a real answer the card renders.
    expect(res.statusCode).toBe(200);
    expect(res.body.charged).toBe(false);
    expect(res.body.cost).toBe(0);
    expect(res.body.rows).toHaveLength(2);
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("DOES charge when nothing changed but a bullet is blocked — naming the gap is work", async () => {
    aiService.rewriteRoleBullets.mockResolvedValue([ROW_BLOCKED, ROW_UNCHANGED]);

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.body.charged).toBe(true);
    expect(Transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rewrite_role" })
    );
  });

  it("never returns an `after` on a blocked row", async () => {
    aiService.rewriteRoleBullets.mockResolvedValue([ROW_BLOCKED, ROW_CHANGED]);

    const res = await post();

    const blocked = res.body.rows.filter((r) => r.blocked);
    expect(blocked).toHaveLength(1);
    blocked.forEach((r) => {
      // A fabricated rewrite is the exact failure mode blocking exists to prevent.
      expect(r.after == null).toBe(true);
      expect(r.blockedReason).toEqual(expect.any(String));
    });
  });

  it("does NOT charge when the model returns nothing usable", async () => {
    aiService.rewriteRoleBullets.mockResolvedValue([]);

    const res = await post();

    expect(res.statusCode).toBe(502);
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("does NOT charge when the rewrite throws", async () => {
    aiService.rewriteRoleBullets.mockRejectedValue(new Error("model exploded"));

    const res = await post();

    expect(res.statusCode).toBe(502);
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("503s (and does not charge) when the AI is unavailable", async () => {
    aiService.rewriteRoleBullets.mockRejectedValue(new aiService.AIUnavailableError("no key"));

    const res = await post();

    expect(res.statusCode).toBe(503);
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("404s on an unknown sortId without calling the model", async () => {
    const res = await post({ sortId: "role-does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe("ENTRY_NOT_FOUND");
    expect(aiService.rewriteRoleBullets).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("400s NOTHING_TO_REWRITE on an entry with no bullets — that CV needs the interview", async () => {
    draft.experience[0].description = "   \n • \n";

    const res = await post();

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("NOTHING_TO_REWRITE");
    expect(aiService.rewriteRoleBullets).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("refuses before calling the AI when the balance is short", async () => {
    setUser({ credits: 0 });

    const res = await post();

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    expect(aiService.rewriteRoleBullets).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("validates the section", async () => {
    const res = await post({ section: "education" });

    expect(res.statusCode).toBe(400);
    expect(aiService.rewriteRoleBullets).not.toHaveBeenCalled();
  });
});
