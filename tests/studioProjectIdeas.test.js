const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// Models + ai.service + jwt mocked; subscription.service, modelSelection and atsCoach are
// REAL, so the actual availableCredits/spendCredits/costForAction/hasSubstance run against
// the mocked User/Transaction. That is what makes "does NOT charge" a real assertion about
// the charge choreography rather than a test of our own stub. Mirrors
// studioRewriteRole.test.js.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const draftId = "60c72b2f9b1d8b2bad6e1a22";

const buildDraft = (over = {}) => ({
  _id: draftId,
  userId: { toString: () => mockUserId },
  title: "Ernest CV — Backend Engineer",
  experience: [
    {
      _sortId: "role-1",
      title: "Engineer",
      company: "Acme",
      description: "• Cut latency\n• Shipped 3 services",
    },
  ],
  education: [{ _sortId: "edu-1", degree: "BSc", school: "Unilag", field: "Computer Science" }],
  skills: [{ name: "Python" }, { name: "SQL" }, { name: "Docker" }],
  projects: [],
  targetJob: {
    title: "Backend Engineer",
    description: "Backend engineer strong in Python and SQL on AWS.",
    brief: { mustHaves: [{ name: "Python" }], niceToHaves: [{ name: "AWS" }] },
    briefHash: null,
  },
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

const IDEA = (over = {}) => ({
  id: "idea-1",
  title: "Query cache for a small REST API",
  type: "personal",
  oneLiner: "Build a caching layer in front of a Python API and measure the latency drop.",
  whyItFits: "Closes the AWS must-have while showing the Python you already list.",
  evidence: "Skills: Python, SQL",
  ...over,
});

describe("POST /api/studio/project-ideas", () => {
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
    aiService.resolveCareerStage.mockReturnValue("mid");
    aiService.buildRoleBrief.mockResolvedValue({ mustHaves: [{ name: "Python" }] });
    aiService.suggestProjects.mockResolvedValue([
      IDEA(),
      IDEA({ id: "idea-2", title: "ETL job for course datasets", type: "course" }),
    ]);
    draft = buildDraft();
    DraftCV.findById.mockResolvedValue(draft);
  });

  const post = (body = {}) =>
    request(app)
      .post("/api/studio/project-ideas")
      .set("Authorization", "Bearer token")
      .send({ draftId, ...body });

  it("charges PROJECT_IDEAS (light = 1) on a non-empty result", async () => {
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.body.ideas).toHaveLength(2);
    expect(res.body.charged).toBe(true);
    expect(res.body.cost).toBe(1);
    expect(Transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "project_ideas" })
    );
    expect(User.updateOne).toHaveBeenCalled();
  });

  it("grounds on the CV markdown and passes existing project titles", async () => {
    draft.projects = [{ _sortId: "proj-1", title: "Pipeline", description: "• Built an ETL job" }];

    await post();

    expect(aiService.suggestProjects).toHaveBeenCalledWith(
      expect.objectContaining({
        cvMarkdown: expect.stringContaining("Acme"),
        existingTitles: ["Pipeline"],
      })
    );
  });

  it("every returned idea carries non-empty evidence — the 'from YOUR CV' proof", async () => {
    const res = await post();

    expect(res.body.ideas.length).toBeGreaterThan(0);
    res.body.ideas.forEach((idea) => {
      expect(typeof idea.evidence).toBe("string");
      expect(idea.evidence.trim().length).toBeGreaterThan(0);
      expect(idea.id).toEqual(expect.any(String));
      expect(["course", "personal", "work"]).toContain(idea.type);
    });
  });

  it("drops an idea whose title duplicates an existing project", async () => {
    draft.projects = [{ _sortId: "proj-1", title: "ETL job for course datasets" }];

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.body.ideas).toHaveLength(1);
    expect(res.body.ideas[0].title).toBe("Query cache for a small REST API");
    expect(res.body.charged).toBe(true);
  });

  it("does NOT charge when the filter leaves nothing — an all-duplicate answer is no answer", async () => {
    draft.projects = [
      { _sortId: "proj-1", title: "Query cache for a small REST API" },
      { _sortId: "proj-2", title: "ETL job for course datasets" },
    ];

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.body.ideas).toEqual([]);
    expect(res.body.charged).toBe(false);
    expect(res.body.cost).toBe(0);
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("does NOT charge when the model returns [] — the client falls through to a blank project", async () => {
    aiService.suggestProjects.mockResolvedValue([]);

    const res = await post();

    // Still a SUCCESS: "no grounded idea" is a real answer, it just isn't a billable one.
    expect(res.statusCode).toBe(200);
    expect(res.body.ideas).toEqual([]);
    expect(res.body.charged).toBe(false);
    expect(res.body.cost).toBe(0);
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("refuses with NOT_ENOUGH_CV — and never calls the AI — when there is nothing to build on", async () => {
    draft = buildDraft({
      // A blank row the Studio minted to hold a _sortId is not experience (hasSubstance).
      experience: [{ _sortId: "role-1", title: "", company: "", description: "" }],
      education: [],
      skills: [{ name: "Python" }, { name: "SQL" }],
    });
    DraftCV.findById.mockResolvedValue(draft);

    const res = await post();

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("NOT_ENOUGH_CV");
    expect(aiService.suggestProjects).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("accepts a CV with only skills once there are 3 of them", async () => {
    draft = buildDraft({ experience: [], education: [] });
    DraftCV.findById.mockResolvedValue(draft);

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(aiService.suggestProjects).toHaveBeenCalled();
  });

  it("refuses BEFORE calling the AI when the balance is short", async () => {
    setUser({ credits: 0 });

    const res = await post();

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    expect(aiService.suggestProjects).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("does NOT charge when the AI is unavailable", async () => {
    aiService.suggestProjects.mockRejectedValue(new aiService.AIUnavailableError("no key"));

    const res = await post();

    expect(res.statusCode).toBe(503);
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(User.updateOne).not.toHaveBeenCalled();
  });

  it("keeps going brief-less when the brief lookup fails", async () => {
    draft.targetJob.brief = null;
    aiService.buildRoleBrief.mockRejectedValue(new Error("brief exploded"));

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(aiService.suggestProjects).toHaveBeenCalledWith(
      expect.objectContaining({ brief: null })
    );
  });

  it("refuses someone else's draft, before any model call", async () => {
    // 401 is the shared loadOwnedDraft contract every other studio action uses.
    draft.userId = { toString: () => "60c72b2f9b1d8b2bad6e1a99" };

    const res = await post();

    expect(res.statusCode).toBe(403);
    expect(aiService.suggestProjects).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    const res = await request(app).post("/api/studio/project-ideas").send({ draftId });
    expect(res.statusCode).toBe(401);
  });
});
