const request = require("supertest");
const app = require("../src/app");
const DraftCV = require("../src/models/DraftCV");
const User = require("../src/models/User");
const settingsService = require("../src/services/settings.service");
const subscription = require("../src/services/subscription.service");
const jwt = require("jsonwebtoken");

// POST /studio/duplicate — forking a finished Studio session.
//
// Two things can go wrong here in ways the user would never see coming, and most of what
// follows is about those:
//
//   1. WHAT TRAVELS. The copy inherits an explicit allow-list. Several fields must NOT
//      come along, and each one is a real bug if it does — a copied sourceApplicationId
//      hijacks Edit on the original analysis, a copied genState hands over free re-rolls
//      that were paid for once. Those are asserted individually, not as a blob.
//   2. WHAT IS CHARGED. No model runs, so there is no AI failure to hide behind: if this
//      charges twice, or charges for a document that was never created, it is this code's
//      fault alone.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/User");
jest.mock("../src/services/settings.service");
jest.mock("../src/services/subscription.service");
jest.mock("jsonwebtoken");

const USER_ID = "60c72b2f9b1d8b2bad6e1a11";
const OTHER_ID = "60c72b2f9b1d8b2bad6e1a22";
const DRAFT_ID = "60c72b2f9b1d8b2bad6e1b11";
const COPY_ID = "60c72b2f9b1d8b2bad6e1c11";
const COST = 20; // the real default (config/creditCosts.js) — priced above GENERATE_CV

// A finished build session carrying everything a real one would: content, the
// conversation, the ledger, the scan — and the fields that must be left behind.
const sourceDoc = (over = {}) => ({
  _id: DRAFT_ID,
  userId: USER_ID,
  studioKind: "build",
  title: "Product Designer CV",
  source: "scratch",
  templateId: "ats-clean",
  outputLang: "en",
  careerStage: "experienced",
  personalInfo: { fullName: "Ada Lovelace" },
  professionalSummary: "Analytical engine specialist.",
  experience: [{ _sortId: "e1", title: "Mathematician", company: "AEC" }],
  education: [{ _sortId: "d1", degree: "BSc", school: "London" }],
  skills: [{ name: "Algorithms" }],
  projects: [],
  certifications: [],
  languages: [],
  targetJob: { title: "Designer", description: "JD text", briefHash: "hash-1" },
  coachChats: { studio: [{ who: "aria", text: "Let's build your CV." }] },
  coachEvidence: { e1: { verified: true } },
  requirementProbes: [{ requirementId: "r1", status: "answered", evidenceId: "ev1" }],
  skillDeclines: [{ requirementId: "r2", name: "Kubernetes" }],
  skillsGenCache: { hash: "sk-1", suggestions: ["React"] },
  skillCanonCache: { hash: "cn-1", roles: {} },
  studioScan: { fitScore: 78, baseline: { fitScore: 41, capturedAt: new Date() } },
  tailoredFrom: null,
  tailoredFromTitle: "",
  // …and the ones that must NOT travel:
  sourceApplicationId: "60c72b2f9b1d8b2bad6e1d11",
  genState: { e1: { hash: "h", freeRerollAvailable: true } },
  studioPending: { kind: "bullets", sortId: "e1" },
  interviewPrep: { isSaved: true, stories: [{ title: "A story" }] },
  exportCount: 4,
  isComplete: true,
  currentStep: "finalize",
  ...over,
});

// Mongoose doc shape the controller actually touches.
const asDoc = (plain) => ({
  ...plain,
  userId: { toString: () => plain.userId },
  toObject: () => plain,
});

const duplicate = (draftId = DRAFT_ID) =>
  request(app).post("/api/studio/duplicate").set("Authorization", "Bearer token").send({ draftId });

let authUser;
let created;

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockReturnValue({ id: USER_ID });

  authUser = {
    _id: USER_ID,
    id: USER_ID,
    role: "user",
    credits: 100,
    plan: "free",
    tier: "free",
  };
  // Serves both protect's .select("-password") and the controller's own .select(...).
  User.findById.mockImplementation(() => ({ select: jest.fn().mockResolvedValue(authUser) }));

  DraftCV.findById.mockResolvedValue(asDoc(sourceDoc()));
  // No recent copy → not an idempotent repeat.
  DraftCV.findOne.mockReturnValue({
    sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  });
  DraftCV.create.mockImplementation(async (doc) => {
    created = doc;
    return { ...doc, _id: COPY_ID };
  });
  DraftCV.deleteOne.mockResolvedValue({ deletedCount: 1 });

  settingsService.getCreditCosts.mockResolvedValue({ DUPLICATE_CV: COST });
  subscription.availableCredits.mockReturnValue(100);
  subscription.isPaidActive.mockReturnValue(false);
  subscription.spendCredits.mockResolvedValue({
    charged: true,
    skipped: false,
    insufficient: false,
    remainingCredits: 80, // 100 - COST(20)
  });
});

describe("What the copy inherits", () => {
  it("copies the CV content, entry _sortIds and all", async () => {
    // The ids ride along on purpose: Aria's per-entry writers address rows by _sortId, so
    // a fork with renumbered entries would be a document she can't edit the same way.
    const res = await duplicate();

    expect(res.statusCode).toBe(201);
    expect(created.personalInfo).toEqual({ fullName: "Ada Lovelace" });
    expect(created.professionalSummary).toBe("Analytical engine specialist.");
    expect(created.experience[0]._sortId).toBe("e1");
    expect(created.education[0]._sortId).toBe("d1");
    expect(created.skills).toHaveLength(1);
  });

  it("copies the CONVERSATION — the whole point of a fork", async () => {
    await duplicate();
    expect(created.coachChats.studio).toHaveLength(1);
    expect(created.coachChats.studio[0].text).toBe("Let's build your CV.");
  });

  it("copies the ledger of what Aria has already been told, alongside it", async () => {
    // These travel with the transcript or not at all. A fork whose chat shows Aria being
    // told "no" while her ledger has forgotten would have her ask all over again.
    await duplicate();
    expect(created.coachEvidence).toEqual({ e1: { verified: true } });
    expect(created.requirementProbes[0].evidenceId).toBe("ev1");
    expect(created.skillDeclines[0].name).toBe("Kubernetes");
  });

  it("copies the job whole, hashes included, so nothing is re-charged", async () => {
    // briefHash is a hash of the JD TEXT, so it stays valid on a copy of the same JD —
    // the Role Brief resolves as a cache hit instead of a fresh AI call.
    await duplicate();
    expect(created.targetJob.briefHash).toBe("hash-1");
    expect(created.targetJob.description).toBe("JD text");
  });

  it("copies the scan INCLUDING its baseline", async () => {
    // The fork inherits the document's history because up to this point it is the same
    // document. Dropping this would blank the score and make a 5-credit duplicate cost 15,
    // since getting it back means a 10-credit re-scan.
    await duplicate();
    expect(created.studioScan.fitScore).toBe(78);
    expect(created.studioScan.baseline.fitScore).toBe(41);
  });

  it("stays a Studio session of the same kind, and keeps the user's presentation", async () => {
    await duplicate();
    expect(created.studioKind).toBe("build"); // else it vanishes from the rail
    expect(created.templateId).toBe("ats-clean");
    expect(created.outputLang).toBe("en");
    expect(created.careerStage).toBe("experienced");
  });

  it("records what it was duplicated from", async () => {
    await duplicate();
    expect(String(created.duplicatedFrom)).toBe(DRAFT_ID);
  });

  it("belongs to the requester, never to whoever the source claimed", async () => {
    DraftCV.findById.mockResolvedValue(asDoc(sourceDoc({ userId: USER_ID })));
    await duplicate();
    expect(created.userId).toBe(USER_ID);
  });
});

describe("What the copy must NOT inherit", () => {
  // Every one of these is a live bug if it travels, so they are asserted one by one
  // rather than as a single "matches snapshot".
  it("drops sourceApplicationId, which would hijack Edit on the original analysis", async () => {
    // analysis.controller.editApplication looks drafts up by
    // { userId, sourceApplicationId, createdAt within 10 min } and returns the newest as
    // "your existing draft" — so a copy carrying this would be handed back instead of the
    // original the user clicked Edit on.
    await duplicate();
    expect(created.sourceApplicationId).toBeUndefined();
  });

  it("drops genState, which is an entitlement to future free work", async () => {
    // freeRerollAvailable per entry. Copying it sells N free generations for the price of
    // a duplicate.
    await duplicate();
    expect(created.genState).toBeUndefined();
  });

  it("drops studioPending — an in-flight generation belonging to the source", async () => {
    await duplicate();
    expect(created.studioPending).toBeUndefined();
  });

  it("drops the source's interview prep and export history", async () => {
    await duplicate();
    expect(created.interviewPrep).toBeUndefined();
    expect(created.exportCount).toBeUndefined();
  });

  it("drops wizard state", async () => {
    await duplicate();
    expect(created.isComplete).toBeUndefined();
    expect(created.currentStep).toBeUndefined();
  });

  it("never carries the source's _id or timestamps", async () => {
    await duplicate();
    expect(created._id).toBeUndefined();
    expect(created.createdAt).toBeUndefined();
    expect(created.updatedAt).toBeUndefined();
  });
});

describe("Naming the copy", () => {
  it("marks it as a copy", async () => {
    await duplicate();
    expect(created.title).toBe("Product Designer CV (copy)");
  });

  it("COUNTS UP rather than stacking suffixes", async () => {
    // Otherwise a copy of a copy reads "My CV (copy) (copy)".
    DraftCV.findById.mockResolvedValue(asDoc(sourceDoc({ title: "My CV (copy)" })));
    await duplicate();
    expect(created.title).toBe("My CV (copy 2)");

    DraftCV.findById.mockResolvedValue(asDoc(sourceDoc({ title: "My CV (copy 7)" })));
    await duplicate();
    expect(created.title).toBe("My CV (copy 8)");
  });

  it("names it in the language the CV is WRITTEN in", async () => {
    // The suffix ends up inside the document's own title, so it follows the document, not
    // whatever language the browser happens to be set to.
    DraftCV.findById.mockResolvedValue(asDoc(sourceDoc({ outputLang: "fr", title: "Mon CV" })));
    await duplicate();
    expect(created.title).toBe("Mon CV (copie)");
  });

  it("falls back to a name when the source has none", async () => {
    DraftCV.findById.mockResolvedValue(asDoc(sourceDoc({ title: "" })));
    await duplicate();
    expect(created.title).toBe("Untitled CV (copy)");
  });
});

describe("Charging", () => {
  it("charges exactly once, attributed to its own transaction type", async () => {
    const res = await duplicate();

    expect(subscription.spendCredits).toHaveBeenCalledTimes(1);
    const [, cost, meta] = subscription.spendCredits.mock.calls[0];
    expect(cost).toBe(COST);
    expect(meta.type).toBe("duplicate_cv");
    // Never null: the sparse-unique index on externalTxId DOES index an explicit null, so
    // writing one collides with every other null (E11000).
    expect(meta).not.toHaveProperty("externalTxId");
    expect(res.body.remainingCredits).toBe(80);
  });

  it("charges only AFTER the copy exists", async () => {
    // Nobody pays for a document that isn't there. If the create throws, no charge is
    // even attempted.
    DraftCV.create.mockRejectedValue(new Error("mongo is down"));
    const res = await duplicate();

    expect(res.statusCode).toBe(500);
    expect(subscription.spendCredits).not.toHaveBeenCalled();
  });

  it("refuses before creating anything when the balance is short", async () => {
    subscription.availableCredits.mockReturnValue(2);
    const res = await duplicate();

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    expect(res.body.required).toBe(COST);
    // The important half: no orphan document was left behind.
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  it("UNDOES the copy if the balance moves between the check and the charge", async () => {
    // Another tab spent the credits in the gap. Deleting the copy is cleaner than
    // refunding: nothing references it yet, and a refund would leave a charge and a
    // reversal in a ledger the user actually reads.
    subscription.spendCredits.mockResolvedValue({
      charged: false,
      insufficient: true,
      remainingCredits: 2,
    });
    const res = await duplicate();

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("INSUFFICIENT_CREDITS");
    expect(DraftCV.deleteOne).toHaveBeenCalledWith({ _id: COPY_ID });
  });

  it("reads the admin-configured price, not a hardcoded one", async () => {
    settingsService.getCreditCosts.mockResolvedValue({ DUPLICATE_CV: 12 });
    await duplicate();
    expect(subscription.spendCredits.mock.calls[0][1]).toBe(12);
  });
});

describe("Double-click safety", () => {
  it("returns the copy it just made instead of making a second", async () => {
    DraftCV.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: COPY_ID, title: "Product Designer CV (copy)" }),
      }),
    });

    const res = await duplicate();

    expect(res.statusCode).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(String(res.body.draftId)).toBe(COPY_ID);
    // Neither a second document nor a second charge.
    expect(DraftCV.create).not.toHaveBeenCalled();
    expect(subscription.spendCredits).not.toHaveBeenCalled();
  });

  it("scopes that guard to this source, this user, and the last few seconds", async () => {
    await duplicate();
    const [filter] = DraftCV.findOne.mock.calls[0];
    expect(filter.userId).toBe(USER_ID);
    expect(String(filter.duplicatedFrom)).toBe(DRAFT_ID);
    // Seconds, not minutes: the failure being absorbed is a double-click on a fast write,
    // so a deliberate second copy a minute later must still go through.
    const windowMs = Date.now() - filter.createdAt.$gte.getTime();
    expect(windowMs).toBeLessThanOrEqual(30 * 1000);
  });
});

describe("Who and what may be duplicated", () => {
  it("refuses an unfinished CV", async () => {
    DraftCV.findById.mockResolvedValue(
      asDoc(sourceDoc({ experience: [{ _sortId: "placeholder" }] }))
    );
    const res = await duplicate();

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("CV_NOT_COMPLETE");
    expect(DraftCV.create).not.toHaveBeenCalled();
    expect(subscription.spendCredits).not.toHaveBeenCalled();
  });

  it("refuses a CV that is not a Studio session at all", async () => {
    DraftCV.findById.mockResolvedValue(asDoc(sourceDoc({ studioKind: null })));
    const res = await duplicate();

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("NOT_A_SESSION");
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  it("refuses someone else's CV", async () => {
    DraftCV.findById.mockResolvedValue(asDoc(sourceDoc({ userId: OTHER_ID })));
    const res = await duplicate();

    expect(res.statusCode).toBe(403);
    expect(DraftCV.create).not.toHaveBeenCalled();
    expect(subscription.spendCredits).not.toHaveBeenCalled();
  });

  it("404s a draft that does not exist", async () => {
    DraftCV.findById.mockResolvedValue(null);
    expect((await duplicate()).statusCode).toBe(404);
  });

  it("400s a missing or malformed draftId", async () => {
    const missing = await request(app)
      .post("/api/studio/duplicate")
      .set("Authorization", "Bearer token")
      .send({});
    expect(missing.statusCode).toBe(400);
    expect((await duplicate("not-an-id")).statusCode).toBe(400);
  });

  it("holds an agent without a plan to the same create gate as every other create", async () => {
    authUser.role = "agent";
    subscription.isPaidActive.mockReturnValue(false);
    const res = await duplicate();

    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe("NEED_AGENT_SUB");
    expect(DraftCV.create).not.toHaveBeenCalled();
  });

  it("lets an agent WITH a plan duplicate", async () => {
    authUser.role = "agent";
    subscription.isPaidActive.mockReturnValue(true);
    expect((await duplicate()).statusCode).toBe(201);
  });
});
