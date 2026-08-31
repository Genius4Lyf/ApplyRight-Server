const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const aiService = require("../src/services/ai.service");
const resumeParser = require("../src/services/resumeParser.service");
const jwt = require("jsonwebtoken");

// Models + ai.service + the parser + jwt mocked. subscription.service is deliberately NOT
// mocked, so the REAL availableCredits/spendCredits run against the mocked
// User/Transaction — which is what makes every "nothing was charged" assertion below a
// statement about the actual charging code rather than about our own stub. Same
// convention as studioDraftJd.test.js and studioScan.test.js.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/ai.service");
jest.mock("../src/services/resumeParser.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const otherUserId = "60c72b2f9b1d8b2bad6e1a99";
const draftId = "60c72b2f9b1d8b2bad6e1a22";

// What a resume looks like once the model has read it VERBATIM: the bullets are the
// user's own words, weak ones included. That is the point — the Studio improves them
// with the user afterwards, so nothing may be polished on the way in.
const EXTRACTED = {
  contactInfo: {
    fullName: "Ernest Akibor",
    email: "ernest@example.com",
    phone: null,
    linkedin: null,
    website: null,
    address: "Lagos",
  },
  skills: ["Pressure control", "Wireline"],
  experience: [
    {
      role: "Field Operator",
      company: "Baker Hughes",
      startDate: "Jan 2021",
      endDate: "Present",
      description: ["Responsible for managing the wireline unit", "Assisted with rig-ups"],
    },
  ],
  education: [{ degree: "BSc", field: "Mechanical Engineering", school: "UNIBEN", date: "2019" }],
  projects: [{ title: "Rig telemetry", link: null, description: ["Built a dashboard"] }],
  seniority: "mid",
  summary: "Field operator with four years offshore.",
};

const buildDraft = (over = {}) => ({
  _id: draftId,
  userId: { toString: () => mockUserId },
  studioKind: "build",
  title: "CV for Field Operator",
  personalInfo: { fullName: "Ernest A", email: "profile@example.com", phone: "0800" },
  professionalSummary: "",
  experience: [],
  projects: [],
  education: [],
  skills: [],
  targetJob: { title: "Field Operator" },
  save: jest.fn().mockResolvedValue(true),
  ...over,
});

describe("POST /api/studio/upload-import", () => {
  let draft;
  let mockUser;

  const setUser = (over = {}) => {
    mockUser = {
      _id: mockUserId,
      id: mockUserId,
      credits: 50,
      role: "user",
      save: jest.fn().mockResolvedValue(true),
      ...over,
    };
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(mockUser) });
    return mockUser;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: mockUserId });
    setUser();
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Transaction.create.mockResolvedValue({});
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });

    draft = buildDraft();
    DraftCV.findById.mockResolvedValue(draft);

    class AIUnavailableError extends Error {}
    aiService.AIUnavailableError = AIUnavailableError;
    aiService.resolveTextModel.mockReturnValue("gpt-4o-mini");
    aiService.extractResumeProfile.mockResolvedValue(EXTRACTED);
    aiService.generateStructuredSkills.mockResolvedValue([
      { name: "Pressure control", category: "Technical" },
    ]);
    resumeParser.parseResume.mockResolvedValue({ rawText: "Ernest Akibor\nField Operator…" });
  });

  const post = (over = {}) => {
    const req = request(app)
      .post("/api/studio/upload-import")
      .set("Authorization", "Bearer token")
      .field("draftId", over.draftId !== undefined ? over.draftId : draftId);
    return over.noFile
      ? req
      : req.attach("resume", Buffer.from("%PDF-1.4 fake"), {
          filename: "cv.pdf",
          contentType: "application/pdf",
        });
  };

  it("imports the CV, charges CREATE_FROM_UPLOAD once, and files it under its own type", async () => {
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(res.body.cost).toBe(15);
    expect(User.updateOne).toHaveBeenCalledTimes(1);
    expect(Transaction.create).toHaveBeenCalledTimes(1);
    expect(Transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "create_from_upload" })
    );
    expect(draft.save).toHaveBeenCalled();
  });

  it("reads the CV VERBATIM — the weak bullet survives exactly as written", async () => {
    await post();

    expect(aiService.extractResumeProfile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ verbatim: true })
    );
    // "Responsible for managing" is exactly the phrasing Aria coaches OUT of a CV. It has
    // to arrive intact, or the user never sees their own words and the coaching that
    // follows has nothing to work on.
    expect(draft.experience[0].description).toBe(
      "• Responsible for managing the wireline unit\n• Assisted with rig-ups"
    );
    expect(draft.professionalSummary).toBe("Field operator with four years offshore.");
  });

  it("mints a _sortId on every imported entry", async () => {
    await post();

    // Not cosmetic: Aria's writers resolve the entry they are editing server-side by
    // _sortId, so an entry without one is invisible to every generate/rewrite action.
    const ids = [...draft.experience, ...draft.projects, ...draft.education].map((e) => e._sortId);
    expect(ids).toHaveLength(3);
    ids.forEach((id) => expect(typeof id).toBe("string"));
    expect(new Set(ids).size).toBe(3);
  });

  it("lets the CV's own contact details win over the profile ones", async () => {
    await post();

    expect(draft.personalInfo.fullName).toBe("Ernest Akibor");
    expect(draft.personalInfo.email).toBe("ernest@example.com");
    // Absent in the CV — the value build-start seeded from the profile stays.
    expect(draft.personalInfo.phone).toBe("0800");
    expect(draft.source).toBe("upload");
  });

  it("keeps a job title the draft already had — an import must not erase it", async () => {
    // This handler REBUILDS personalInfo from an explicit field list, so anything not
    // named there is silently dropped. No title is extracted from an uploaded CV, which
    // means the only copy is the one already on the draft.
    DraftCV.findById.mockResolvedValue(
      (draft = buildDraft({
        personalInfo: {
          fullName: "Ernest A",
          email: "profile@example.com",
          phone: "0800",
          currentJobTitle: "Field Operator",
        },
      }))
    );

    await post();

    expect(draft.personalInfo.currentJobTitle).toBe("Field Operator");
  });

  it("reports what actually landed", async () => {
    const res = await post();

    expect(res.body.imported).toEqual({
      experience: 1,
      education: 1,
      projects: 1,
      skills: 1,
      summary: true,
    });
  });

  it("checks the balance BEFORE parsing anything", async () => {
    setUser({ credits: 3 });

    const res = await post();

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    expect(res.body.required).toBe(15);
    expect(resumeParser.parseResume).not.toHaveBeenCalled();
    expect(aiService.extractResumeProfile).not.toHaveBeenCalled();
  });

  it("does not charge for a file it cannot read", async () => {
    resumeParser.parseResume.mockResolvedValue({ rawText: "   " });

    const res = await post();

    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe("NO_TEXT");
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("does not charge when the extraction finds no CV content", async () => {
    aiService.extractResumeProfile.mockResolvedValue({
      contactInfo: {},
      skills: [],
      experience: [],
      education: [],
      projects: [],
      summary: "",
    });

    const res = await post();

    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe("NOTHING_EXTRACTED");
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
    expect(draft.save).not.toHaveBeenCalled();
  });

  it("refuses to import over a CV that already has content", async () => {
    DraftCV.findById.mockResolvedValue(
      buildDraft({ experience: [{ _sortId: "s1", title: "Existing role" }] })
    );

    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("DRAFT_NOT_EMPTY");
    expect(resumeParser.parseResume).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("refuses to import into someone else's CV", async () => {
    DraftCV.findById.mockResolvedValue(buildDraft({ userId: { toString: () => otherUserId } }));

    const res = await post();

    expect(res.statusCode).toBe(403);
    expect(resumeParser.parseResume).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("still imports when skill categorisation fails", async () => {
    // A failed categorisation must not sink an import the user is about to pay for —
    // the flat extracted list is a perfectly usable fallback.
    aiService.generateStructuredSkills.mockRejectedValue(new Error("model blew up"));

    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(draft.skills.map((s) => s.name)).toEqual(["Pressure control", "Wireline"]);
    expect(draft.skills.every((s) => s.isAutoGenerated === false)).toBe(true);
  });

  it("rejects a missing draftId without touching the parser", async () => {
    const res = await post({ draftId: "not-an-id" });

    expect(res.statusCode).toBe(400);
    expect(resumeParser.parseResume).not.toHaveBeenCalled();
  });

  it("rejects a request with no file", async () => {
    const res = await post({ noFile: true });

    expect(res.statusCode).toBe(400);
    expect(Transaction.create).not.toHaveBeenCalled();
  });
});
