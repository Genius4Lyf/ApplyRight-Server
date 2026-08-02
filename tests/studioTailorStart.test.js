const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const jwt = require("jsonwebtoken");

// Mocks: models + ai.service + jwt. resolveDraftBrief is NOT mocked — the REAL one runs
// against the mocked DraftCV/aiService, so the test proves the brief is actually built
// and cached onto the COPY (not the source).
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const otherUserId = "60c72b2f9b1d8b2bad6e1a99";
const sourceId = "60c72b2f9b1d8b2bad6e1a22";
const copyId = "60c72b2f9b1d8b2bad6e1a33";

const JOB = {
  jobTitle: "Wireline Field Operator",
  jobDescription:
    "We need a wireline field operator with strong pressure-control and rig-up experience for offshore work.",
};

// A fully-populated source draft — every field the clone must (or must not) carry.
const buildSource = (over = {}) => ({
  _id: sourceId,
  userId: { toString: () => mockUserId },
  title: "Ernest Akibor CV",
  personalInfo: { fullName: "Ernest Akibor", email: "e@example.com" },
  professionalSummary: "Field operator with 4 years offshore.",
  experience: [{ _sortId: "sort-1", title: "Operator", company: "Baker", description: "• Did things" }],
  projects: [{ _sortId: "proj-1", title: "Rig telemetry", description: "• Built a thing" }],
  education: [{ degree: "BSc", school: "UNIBEN" }],
  certifications: [{ name: "H2S", issuer: "OPITO" }],
  skills: [{ name: "Pressure control", category: "Technical" }],
  // These must NOT be copied.
  coachChats: { experience: [{ who: "user", text: "private" }] },
  genState: { "sort-1": { hash: "abc" } },
  skillsGenCache: { hash: "xyz", suggestions: [] },
  interviewPrep: { isSaved: true },
  exportCount: 7,
  isComplete: true,
  sourceApplicationId: "60c72b2f9b1d8b2bad6e1a44",
  toObject() {
    const { toObject, userId, ...rest } = this;
    return { ...rest, userId: mockUserId };
  },
  ...over,
});

describe("POST /api/studio/tailor-start", () => {
  let created;

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: mockUserId, id: mockUserId, role: "user" }),
    });
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });

    aiService.buildRoleBrief.mockResolvedValue({
      role: "Wireline Field Operator",
      company: "Baker Hughes",
      companyType: "enterprise",
      seniority: "mid",
      mustHaves: [{ name: "Pressure control", importance: "must_have" }],
    });

    DraftCV.findById.mockResolvedValue(buildSource());
    DraftCV.create.mockImplementation(async (doc) => {
      created = { ...doc, _id: copyId, save: jest.fn().mockResolvedValue(true) };
      return created;
    });
  });

  const post = (body = {}) =>
    request(app)
      .post("/api/studio/tailor-start")
      .set("Authorization", "Bearer token")
      .send({ sourceDraftId: sourceId, ...JOB, ...body });

  it("clones CONTENT only and binds the copy to the target job", async () => {
    const res = await post();

    expect(res.statusCode).toBe(201);
    expect(res.body.draftId).toBe(copyId);
    expect(res.body.tailoredFrom).toBe(sourceId);

    // Content came across.
    expect(created.personalInfo.fullName).toBe("Ernest Akibor");
    expect(created.professionalSummary).toBe("Field operator with 4 years offshore.");
    expect(created.experience[0]._sortId).toBe("sort-1"); // _sortIds copied as-is
    expect(created.projects).toHaveLength(1);
    expect(created.education).toHaveLength(1);
    expect(created.certifications).toHaveLength(1);
    expect(created.skills).toHaveLength(1);

    // Provenance + target job.
    expect(created.title).toBe("Ernest Akibor CV — Wireline Field Operator");
    // source stays 'scratch': admin's Creation Method analytics buckets drafts by
    // `source`, so a 'studio' enum value would silently reclassify them there. Studio
    // identity lives on studioKind instead.
    expect(created.source).toBe("scratch");
    expect(created.studioKind).toBe("tailor");
    expect(created.tailoredFromTitle).toBe("Ernest Akibor CV");
    expect(created.tailoredFrom).toBe(sourceId);
    expect(created.tailoredForJob).toEqual({ title: JOB.jobTitle });
    // targetJob also carries brief + briefHash by now (resolveDraftBrief caches onto
    // the copy — asserted in its own test below), so check the job fields specifically.
    expect(created.targetJob.title).toBe(JOB.jobTitle);
    expect(created.targetJob.description).toBe(JOB.jobDescription);
    expect(created.userId).toBe(mockUserId);
  });

  it("persists a pre-draft model choice on the tailored copy", async () => {
    const res = await post({ model: "claude-sonnet-5" });

    expect(res.statusCode).toBe(201);
    expect(created.studioModelId).toBe("claude-sonnet-5");
    expect(aiService.buildRoleBrief).toHaveBeenCalledWith(
      JOB.jobDescription,
      { title: JOB.jobTitle },
      expect.objectContaining({ modelId: "claude-sonnet-5" })
    );
  });

  it("does NOT copy conversation, caches, prep or export history", async () => {
    await post();

    expect(created.coachChats).toBeUndefined();
    expect(created.genState).toBeUndefined();
    expect(created.skillsGenCache).toBeUndefined();
    expect(created.interviewPrep).toBeUndefined();
    expect(created.exportCount).toBeUndefined();
    expect(created.isComplete).toBeUndefined();
    expect(created.sourceApplicationId).toBeUndefined();
  });

  it("builds and caches the Role Brief on the COPY, leaving the source untouched", async () => {
    const source = buildSource();
    DraftCV.findById.mockResolvedValue(source);

    const res = await post();

    expect(aiService.buildRoleBrief).toHaveBeenCalledTimes(1);
    expect(res.body.brief.role).toBe("Wireline Field Operator");
    // resolveDraftBrief persisted brief + briefHash onto the copy and saved IT.
    expect(created.targetJob.brief.companyType).toBe("enterprise");
    expect(created.targetJob.briefHash).toEqual(expect.any(String));
    expect(created.save).toHaveBeenCalled();
    // The source was never written.
    expect(source.save).toBeUndefined();
  });

  it("still returns the clone when the brief can't be built", async () => {
    aiService.buildRoleBrief.mockRejectedValue(new Error("AI down"));

    const res = await post();

    expect(res.statusCode).toBe(201);
    expect(res.body.draftId).toBe(copyId);
    expect(res.body.brief).toBeNull();
  });

  it("rejects a source CV owned by someone else", async () => {
    DraftCV.findById.mockResolvedValue(
      buildSource({ userId: { toString: () => otherUserId } })
    );

    const res = await post();

    expect(res.statusCode).toBe(401);
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  it("404s a missing source CV", async () => {
    DraftCV.findById.mockResolvedValue(null);

    const res = await post();

    expect(res.statusCode).toBe(404);
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  it("validates the job title and description", async () => {
    expect((await post({ jobTitle: "  " })).statusCode).toBe(400);
    expect((await post({ jobDescription: "" })).statusCode).toBe(400);
    expect((await post({ sourceDraftId: "not-an-objectid" })).statusCode).toBe(400);
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  it("gates agents without an active plan (402 NEED_AGENT_SUB)", async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: mockUserId, id: mockUserId, role: "agent" }),
    });

    const res = await post();

    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe("NEED_AGENT_SUB");
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  describe("with a confirmed brief from the preview step", () => {
    const confirmed = {
      role: "Wireline Field Operator",
      company: "Baker Hughes",
      companyType: "smb", // the user CORRECTED this away from the inferred "enterprise"
      seniority: "senior",
      mustHaves: [{ name: "Rig-up", importance: "must_have" }],
    };

    it("persists it as-is and does NOT call the AI again", async () => {
      const res = await post({ brief: confirmed });

      expect(res.statusCode).toBe(201);
      // The whole point: no second extraction.
      expect(aiService.buildRoleBrief).not.toHaveBeenCalled();
      // The user's correction is what landed, not a fresh inference.
      expect(created.targetJob.brief.companyType).toBe("smb");
      expect(created.targetJob.brief.seniority).toBe("senior");
      expect(created.targetJob.briefHash).toEqual(expect.any(String));
      expect(res.body.brief.companyType).toBe("smb");
      // Cache hit inside resolveDraftBrief → nothing to re-save.
      expect(created.save).not.toHaveBeenCalled();
    });

    it("keys the persisted brief by the SAME hash the preview would produce", async () => {
      const { briefHashFor } = require("../src/controllers/coach.controller");
      await post({ brief: confirmed });
      expect(created.targetJob.briefHash).toBe(briefHashFor(JOB.jobDescription));
    });

    it("ignores a malformed brief and builds one instead", async () => {
      for (const bad of ["not-an-object", 42, ["a"], null]) {
        jest.clearAllMocks();
        DraftCV.findById.mockResolvedValue(buildSource());
        aiService.buildRoleBrief.mockResolvedValue({ role: "Rebuilt", companyType: "unknown" });

        const res = await post({ brief: bad });

        expect(res.statusCode).toBe(201);
        expect(aiService.buildRoleBrief).toHaveBeenCalledTimes(1);
        expect(res.body.brief.role).toBe("Rebuilt");
      }
    });
  });
});

describe("POST /api/studio/build-start", () => {
  let created;

  const profile = {
    _id: mockUserId,
    id: mockUserId,
    role: "user",
    firstName: "Ernest",
    otherName: "O",
    lastName: "Akibor",
    email: "e@example.com",
    phone: "+2348012345678",
    linkedinUrl: "linkedin.com/in/ernest",
    portfolioUrl: "ernest.dev",
  };

  const setUser = (over = {}) =>
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ ...profile, ...over }),
    });

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: mockUserId });
    setUser();
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    aiService.buildRoleBrief.mockResolvedValue({ role: "Field Operator", companyType: "smb" });
    DraftCV.create.mockImplementation(async (doc) => {
      created = { ...doc, _id: "build1", save: jest.fn().mockResolvedValue(true) };
      return created;
    });
  });

  const start = (body = {}) =>
    request(app).post("/api/studio/build-start").set("Authorization", "Bearer token").send(body);

  it("creates an EMPTY build session marked studioKind:'build'", async () => {
    const res = await start();

    expect(res.statusCode).toBe(201);
    expect(res.body.draftId).toBe("build1");
    expect(created.studioKind).toBe("build");
    expect(created.source).toBe("scratch");
    expect(created.title).toBe("Untitled CV");
    expect(created.userId).toBe(mockUserId);
    // Nothing cloned — this is a blank document.
    expect(created.experience).toBeUndefined();
    expect(created.skills).toBeUndefined();
    expect(created.targetJob).toBeUndefined();
  });

  it("persists a pre-draft model choice on the new build", async () => {
    const res = await start({ model: "claude-sonnet-5" });

    expect(res.statusCode).toBe(201);
    expect(created.studioModelId).toBe("claude-sonnet-5");
  });

  it("prefills contact details with the SAME mapping as the builder's Heading step", async () => {
    await start();

    expect(created.personalInfo).toEqual({
      fullName: "Ernest O Akibor", // firstName + otherName + lastName
      email: "e@example.com",
      phone: "+2348012345678",
      linkedin: "linkedin.com/in/ernest", // ← user.linkedinUrl
      website: "ernest.dev", // ← user.portfolioUrl
    });
    // User has no address, so none is invented.
    expect(created.personalInfo.address).toBeUndefined();
  });

  it("omits fields the profile doesn't have rather than writing empty strings", async () => {
    setUser({ otherName: undefined, phone: undefined, linkedinUrl: undefined, portfolioUrl: undefined });

    await start();

    expect(created.personalInfo).toEqual({ fullName: "Ernest Akibor", email: "e@example.com" });
  });

  it("creates a usable draft even for a profile with nothing filled in", async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: mockUserId, id: mockUserId, role: "user" }),
    });

    const res = await start();

    expect(res.statusCode).toBe(201);
    expect(created.personalInfo).toEqual({}); // the card falls back to asking
  });

  it("binds a job and caches its brief when one is supplied", async () => {
    const res = await start(JOB);

    expect(created.targetJob).toMatchObject({
      title: JOB.jobTitle,
      description: JOB.jobDescription,
    });
    expect(created.title).toBe("CV for Wireline Field Operator");
    expect(created.targetJob.brief.role).toBe("Field Operator");
    expect(created.targetJob.briefHash).toEqual(expect.any(String));
    expect(created.save).toHaveBeenCalled();
    expect(res.body.brief.role).toBe("Field Operator");
  });

  it("still creates the draft when the brief can't be built", async () => {
    aiService.buildRoleBrief.mockRejectedValue(new Error("AI down"));

    const res = await start(JOB);

    expect(res.statusCode).toBe(201);
    expect(res.body.brief).toBeNull();
    expect(res.body.draftId).toBe("build1");
  });

  it("rejects a half-supplied job rather than silently dropping it", async () => {
    expect((await start({ jobTitle: "Operator" })).statusCode).toBe(400);
    expect((await start({ jobDescription: "too short" })).statusCode).toBe(400);
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  it("gates agents without an active plan — no bypass via the build door", async () => {
    setUser({ role: "agent" });
    // protect() resolves req.user from the same mock, so the gate sees role 'agent'.
    const res = await start();

    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe("NEED_AGENT_SUB");
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    expect((await request(app).post("/api/studio/build-start").send({})).statusCode).toBe(401);
  });

  it("produces a MASTER CV — never a copy", async () => {
    // A built CV is the thing tailored copies are made FROM. Setting tailoredFrom here
    // would make it look like a derivative in My CVs, and a later tailoring would chain
    // copies off a copy.
    await start(JOB);

    expect(created.tailoredFrom).toBeUndefined();
    expect(created.tailoredFromTitle).toBeUndefined();
    expect(created.tailoredForJob).toBeUndefined();
    expect(created.studioKind).toBe("build");
  });
});

describe("GET /api/studio/sessions", () => {
  let chain;

  const rows = [
    {
      _id: "s1",
      studioKind: "tailor",
      title: "Ernest CV — Wireline Operator",
      tailoredForJob: { title: "Wireline Operator" },
      targetJob: { brief: { company: "Baker Hughes" } },
      tailoredFromTitle: "Ernest CV",
      studioScan: { fitScore: 72 },
      updatedAt: new Date("2026-07-20"),
    },
    {
      _id: "s2",
      studioKind: "build",
      title: "Untitled CV",
      updatedAt: new Date("2026-07-19"),
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: mockUserId, id: mockUserId, role: "user" }),
    });
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });

    chain = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(rows),
    };
    DraftCV.find.mockReturnValue(chain);
  });

  const list = () =>
    request(app).get("/api/studio/sessions").set("Authorization", "Bearer token");

  it("returns only THIS user's Studio drafts, newest-updated first", async () => {
    const res = await list();

    expect(res.statusCode).toBe(200);
    const [filter] = DraftCV.find.mock.calls[0];
    expect(filter.userId).toBe(mockUserId);
    expect(filter.studioKind).toEqual({ $ne: null }); // Studio sessions only
    expect(chain.sort).toHaveBeenCalledWith({ updatedAt: -1 });
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it("projects ONLY the fields the rail renders — never whole drafts", async () => {
    await list();
    const [, projection] = DraftCV.find.mock.calls[0];

    // The rail needs these…
    expect(projection).toEqual({
      studioKind: 1,
      title: 1,
      "tailoredForJob.title": 1,
      "targetJob.brief.company": 1,
      tailoredFromTitle: 1,
      "studioScan.fitScore": 1,
      updatedAt: 1,
    });
    // …and must never ship these. Transcripts and CV bodies are the whole reason
    // this is a projection and not a find().
    ["coachChats", "experience", "skills", "personalInfo", "studioScan.evidence"].forEach(
      (heavy) => expect(projection[heavy]).toBeUndefined()
    );
    expect(chain.lean).toHaveBeenCalled();
  });

  it("shapes rows for the rail, distinguishing tailor from build", async () => {
    const res = await list();

    expect(res.body.sessions).toHaveLength(2);
    const [tailoring, build] = res.body.sessions;

    expect(tailoring).toMatchObject({
      _id: "s1",
      kind: "tailor",
      jobTitle: "Wireline Operator",
      company: "Baker Hughes",
      sourceTitle: "Ernest CV",
      fitScore: 72,
    });

    // A build session has no job and no score — null, not 0.
    expect(build.kind).toBe("build");
    expect(build.fitScore).toBeNull();
    expect(build.jobTitle).toBe("");
  });

  it("reports a never-scanned tailoring as null rather than zero", async () => {
    chain.lean.mockResolvedValue([{ _id: "s3", studioKind: "tailor", title: "X", studioScan: {} }]);
    const res = await list();
    expect(res.body.sessions[0].fitScore).toBeNull();
  });

  it("returns an empty list for a user with no sessions", async () => {
    chain.lean.mockResolvedValue([]);
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/studio/sessions");
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/studio/brief-preview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: mockUserId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: mockUserId, id: mockUserId, role: "user" }),
    });
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
    aiService.buildRoleBrief.mockResolvedValue({
      role: "Wireline Field Operator",
      companyType: "enterprise",
      mustHaves: [{ name: "Pressure control", importance: "must_have" }],
    });
  });

  const preview = (body = {}) =>
    request(app)
      .post("/api/studio/brief-preview")
      .set("Authorization", "Bearer token")
      .send({ ...JOB, ...body });

  it("reads the job with NO draft attached — nothing is created", async () => {
    const res = await preview();

    expect(res.statusCode).toBe(200);
    expect(res.body.brief.role).toBe("Wireline Field Operator");
    expect(aiService.buildRoleBrief).toHaveBeenCalledWith(
      JOB.jobDescription,
      { title: JOB.jobTitle },
      expect.objectContaining({ operation: "studioBriefPreview" })
    );
    // The whole promise of previewing before committing.
    expect(DraftCV.create).not.toHaveBeenCalled();
    expect(DraftCV.findById).not.toHaveBeenCalled();
  });

  it("routes a pre-draft preview through the selected model", async () => {
    const res = await preview({ model: "claude-sonnet-5" });

    expect(res.statusCode).toBe(200);
    expect(aiService.buildRoleBrief).toHaveBeenCalledWith(
      JOB.jobDescription,
      { title: JOB.jobTitle },
      expect.objectContaining({ modelId: "claude-sonnet-5" })
    );
  });

  it("returns brief: null when the AI is unavailable, rather than failing the intake", async () => {
    aiService.buildRoleBrief.mockRejectedValue(new Error("AI down"));

    const res = await preview();

    expect(res.statusCode).toBe(200);
    expect(res.body.brief).toBeNull();
  });

  it("applies the same validation floor as tailor-start", async () => {
    expect((await preview({ jobTitle: "  " })).statusCode).toBe(400);
    expect((await preview({ jobDescription: "" })).statusCode).toBe(400);
    expect((await preview({ jobDescription: "too short" })).statusCode).toBe(400);
    expect(aiService.buildRoleBrief).not.toHaveBeenCalled();
  });

  it("requires auth", async () => {
    const res = await request(app).post("/api/studio/brief-preview").send(JOB);
    expect(res.statusCode).toBe(401);
  });
});
