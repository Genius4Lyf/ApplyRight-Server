// Unit tests for the credit-cost resolver. The SystemSettings model is mocked;
// config/creditCosts (the real defaults) is used as-is. These guard the
// behavior-neutral invariant: with no admin overrides, getCreditCosts() returns
// exactly the real hardcoded defaults, and an override changes the value that
// controllers charge.
jest.mock("../src/models/SystemSettings");

const SystemSettings = require("../src/models/SystemSettings");
const settingsService = require("../src/services/settings.service");
const { DEFAULT_CREDIT_COSTS } = require("../src/config/creditCosts");

describe("settings.service.getCreditCosts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Costs are cached for a short window — clear it so each test resolves fresh.
    settingsService.invalidateCreditCostsCache();
  });

  it("returns the real defaults when no overrides exist", async () => {
    // Fresh doc: creditCosts is an empty Mongoose-style Map.
    SystemSettings.getInstance = jest.fn().mockResolvedValue({ creditCosts: new Map() });

    const costs = await settingsService.getCreditCosts();

    expect(costs).toEqual(DEFAULT_CREDIT_COSTS);
    // Spot-check the documented real values (would catch accidental default drift).
    expect(costs.ANALYSIS).toBe(10);
    expect(costs.GENERATE_CV).toBe(10);
    expect(costs.GENERATE_COVER_LETTER).toBe(5);
    expect(costs.GENERATE_BUNDLE).toBe(18);
    expect(costs.CREATE_FROM_UPLOAD).toBe(15);
    expect(costs.GRADE_ANSWER).toBe(1);
    expect(costs.GRADE_STORY).toBe(1);
    expect(costs.FOLLOWUP).toBe(1);
    expect(costs.TEMPLATE_UNLOCK).toBe(30);
  });

  it("merges a persisted override on top of defaults (Mongoose Map safe)", async () => {
    // A real Map here proves the resolver converts before merging: a naive
    // { ...DEFAULT, ...map } spread would silently DROP every Map entry and this
    // assertion would fail.
    SystemSettings.getInstance = jest
      .fn()
      .mockResolvedValue({ creditCosts: new Map([["ANALYSIS", 25]]) });

    const costs = await settingsService.getCreditCosts();

    expect(costs.ANALYSIS).toBe(25);
    expect(costs.ANALYSIS).not.toBe(DEFAULT_CREDIT_COSTS.ANALYSIS);
    // Non-overridden keys still fall back to their defaults.
    expect(costs.GENERATE_CV).toBe(DEFAULT_CREDIT_COSTS.GENERATE_CV);
  });

  it("re-reads a changed override after cache invalidation (persist → re-read)", async () => {
    const doc = { creditCosts: new Map() };
    SystemSettings.getInstance = jest.fn().mockResolvedValue(doc);

    // No override yet → default.
    expect((await settingsService.getCreditCosts()).GENERATE_CV).toBe(10);

    // Persist a new override, then invalidate (exactly what updateSettings does).
    doc.creditCosts.set("GENERATE_CV", 42);
    settingsService.invalidateCreditCostsCache();

    // The next resolve reflects the persisted change — this is the value the
    // controllers charge.
    expect((await settingsService.getCreditCosts()).GENERATE_CV).toBe(42);
  });

  it("falls back to defaults when the settings doc has no creditCosts", async () => {
    SystemSettings.getInstance = jest.fn().mockResolvedValue({});

    const costs = await settingsService.getCreditCosts();

    expect(costs).toEqual(DEFAULT_CREDIT_COSTS);
  });
});
