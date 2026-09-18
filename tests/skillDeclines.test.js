const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const DraftCV = require("../src/models/DraftCV");
const SystemSettings = require("../src/models/SystemSettings");
const jwt = require("jsonwebtoken");

jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/SystemSettings");
jest.mock("jsonwebtoken");

// A "no" is honoured everywhere and forever: buildHuntProbe refuses to ask again and
// targetRequirementsForEntry drops it from every entry. That was right while the answer was
// hidden — but the interview checklist now SHOWS it, and a visible permanent state with no
// way out turns a mis-tap into a requirement the user can never evidence.
//
// This endpoint had no test at all before the undo was added.

const userId = "60c72b2f9b1d8b2bad6e1a11";
const draftId = "60c72b2f9b1d8b2bad6e1a22";

const draft = (skillDeclines = []) => ({
  _id: draftId,
  userId: { toString: () => userId },
  skillDeclines,
  skillsGenCache: { hash: "something" },
  save: jest.fn().mockResolvedValue(true),
});

const post = (body) =>
  request(app).post("/api/ai/skill-declines").set("Authorization", "Bearer t").send(body);

describe("POST /api/ai/skill-declines", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: userId });
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: userId, id: userId, role: "user" }),
    });
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
  });

  describe("recording a no", () => {
    it("adds a decline and drops the cached generation it would change", async () => {
      const doc = draft();
      DraftCV.findById.mockResolvedValue(doc);

      const res = await post({ draftId, declines: [{ name: "Permit-to-Work", level: "never" }] });

      expect(res.status).toBe(200);
      expect(res.body.declined).toBe(1);
      expect(doc.skillDeclines[0]).toMatchObject({
        name: "Permit-to-Work",
        level: "never",
        source: "skills_card",
      });
      expect(doc.skillsGenCache).toBeUndefined();
    });

    it("never records the same refusal twice", async () => {
      const doc = draft([{ name: "Permit-to-Work", level: "never" }]);
      DraftCV.findById.mockResolvedValue(doc);

      const res = await post({ draftId, declines: ["permit-to-work"] });

      expect(res.body.declined).toBe(0);
      expect(doc.save).not.toHaveBeenCalled();
    });
  });

  describe("taking a no back", () => {
    it("removes the decline, matched on name the way every reader matches", async () => {
      const doc = draft([
        { name: "Permit-to-Work", level: "never" },
        { name: "Troubleshooting", level: "never" },
      ]);
      DraftCV.findById.mockResolvedValue(doc);

      // Different case on purpose: the interview writes the requirement's name, the skills
      // card writes whatever the user typed.
      const res = await post({ draftId, undecline: ["permit-to-work"] });

      expect(res.status).toBe(200);
      expect(res.body.undeclined).toBe(1);
      expect(doc.skillDeclines.map((r) => r.name)).toEqual(["Troubleshooting"]);
      // What may be asked about has changed, so a cached generation is no longer the
      // answer to the current question.
      expect(doc.skillsGenCache).toBeUndefined();
      expect(doc.save).toHaveBeenCalled();
    });

    it("accepts the object shape as well as a bare name", async () => {
      const doc = draft([{ name: "Permit-to-Work", level: "never" }]);
      DraftCV.findById.mockResolvedValue(doc);

      const res = await post({ draftId, undecline: [{ name: "Permit-to-Work" }] });

      expect(res.body.undeclined).toBe(1);
      expect(doc.skillDeclines).toEqual([]);
    });

    it("writes nothing when there was no such decline", async () => {
      const doc = draft([{ name: "Troubleshooting", level: "never" }]);
      DraftCV.findById.mockResolvedValue(doc);

      const res = await post({ draftId, undecline: ["Permit-to-Work"] });

      expect(res.body.undeclined).toBe(0);
      expect(doc.save).not.toHaveBeenCalled();
      expect(doc.skillsGenCache).toBeDefined();
    });

    it("refuses a draft the caller does not own", async () => {
      DraftCV.findById.mockResolvedValue({
        ...draft([{ name: "Permit-to-Work" }]),
        userId: { toString: () => "60c72b2f9b1d8b2bad6e1a99" },
      });

      const res = await post({ draftId, undecline: ["Permit-to-Work"] });

      expect(res.status).toBe(404);
    });
  });
});
