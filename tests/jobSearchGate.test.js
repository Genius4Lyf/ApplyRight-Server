const express = require("express");
const request = require("supertest");

// PARKING THE JOB-SEARCH FEATURE.
//
// `/api/job-search` is public and unauthenticated, and nothing in the app links to the
// one page that uses it. Left ungated, the only traffic it can attract is a crawler
// making this server scrape Jobberman from our IP, for a feature no user can reach.
//
// The admin panel has always had a "Job Search" toggle and the schema has always had
// `features.enableJobSearch` — read by NOTHING, so flipping it did nothing. Same shape
// as the free-templates promo that was set in admin and silently ignored by the
// download page. This suite exists so it cannot quietly go dead again.
//
// SettingsService is mocked, not the SystemSettings model — automocking the model
// leaves `getInstance` returning undefined, which makes the gate look like it is
// working when it is really just erroring. maintenance.test.js records the same trap.
jest.mock("../src/services/settings.service");

const SettingsService = require("../src/services/settings.service");
const { requireFeature } = require("../src/middleware/featureFlag.middleware");

const appWith = () => {
  const app = express();
  app.get("/api/job-search/trending", requireFeature("enableJobSearch"), (req, res) =>
    res.json({ ok: true })
  );
  return app;
};

const settingsAre = (features) => {
  SettingsService.getSettings.mockResolvedValue({ features });
};

describe("the job-search feature gate", () => {
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => errorSpy.mockRestore());

  it("switches the routes off, and says so in a way logs can read", async () => {
    settingsAre({ enableJobSearch: false });

    const res = await request(appWith()).get("/api/job-search/trending");

    expect(res.statusCode).toBe(503);
    // A CODE rather than a bare 404: "off" must read as off, not as a routing bug
    // somebody spends an afternoon chasing.
    expect(res.body.code).toBe("FEATURE_DISABLED");
    expect(res.body.feature).toBe("enableJobSearch");
  });

  it("lets them through when the toggle is on", async () => {
    settingsAre({ enableJobSearch: true });

    const res = await request(appWith()).get("/api/job-search/trending");

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("requires the flag to be exactly true, not merely present", async () => {
    // A settings document written before this key existed has it undefined, and a
    // half-migrated one could hold a string. Neither is consent to start scraping.
    for (const value of [undefined, null, 0, "", "true"]) {
      settingsAre({ enableJobSearch: value });
      const res = await request(appWith()).get("/api/job-search/trending");
      expect(res.statusCode).toBe(503);
    }
  });

  it("FAILS CLOSED when settings cannot be read", async () => {
    // The opposite of the maintenance gate, which fails OPEN so a database blip cannot
    // lock everyone out of the app. The trade runs the other way here: wrongly blocking
    // costs an unlinked page a 503, wrongly allowing means scraping somebody else's site
    // because a settings read timed out. Nobody is locked out of anything by this.
    SettingsService.getSettings.mockRejectedValue(new Error("mongo is down"));

    const res = await request(appWith()).get("/api/job-search/trending");

    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("FEATURE_DISABLED");
  });
});

// A guard, not a behaviour test. The gate must sit on the parked LISTINGS feature and
// nowhere near the CV builder.
describe("the gate is mounted on the right router", () => {
  const fs = require("fs");
  const path = require("path");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");

  const mountLine = (prefix) =>
    appSource.split(/\r?\n/).find((line) => line.includes(`app.use("${prefix}"`)) || "";

  it("gates /api/job-search", () => {
    expect(mountLine("/api/job-search")).toContain('requireFeature("enableJobSearch")');
  });

  it("does NOT gate /api/jobs — that is the CV builder", () => {
    // /api/jobs/extract is what the Target step calls to read a job description. Gating
    // it would break building a CV, which is the opposite of parking a side feature.
    const line = mountLine("/api/jobs");
    expect(line).not.toBe("");
    expect(line).not.toContain("requireFeature");
  });
});
