// modelSelection.service — resolution precedence, server-side gating, and the tier-aware
// charge (flagship always meters; light is unlimited on a paid plan). settings + the
// credit spine are mocked so we test the selection logic in isolation.
jest.mock("../src/services/settings.service");
jest.mock("../src/services/subscription.service");

const settings = require("../src/services/settings.service");
const subscription = require("../src/services/subscription.service");
const ms = require("../src/services/modelSelection.service");

// Clear call history before every test (runs BEFORE each describe's own beforeEach, which
// re-arms the return values) so counts never leak across tests.
beforeEach(() => jest.clearAllMocks());

describe("resolveModelId — session > draft > user > default", () => {
  it("an explicit session pick wins", () => {
    expect(
      ms.resolveModelId({
        sessionModelId: "gpt-5",
        draft: { studioModelId: "gpt-4o" },
        user: { aiModelId: "kimi-k2.5" },
      })
    ).toBe("gpt-5");
  });
  it("else the draft's stored model", () => {
    expect(
      ms.resolveModelId({ draft: { studioModelId: "gpt-4o" }, user: { aiModelId: "kimi-k2.5" } })
    ).toBe("gpt-4o");
  });
  it("else the user default, else DEFAULT_MODEL", () => {
    expect(ms.resolveModelId({ user: { aiModelId: "kimi-k2.5" } })).toBe("kimi-k2.5");
    expect(ms.resolveModelId({})).toBe("gpt-4o-mini");
  });
});

describe("gateModel — server rejects an unexposed/unknown model", () => {
  beforeEach(() => {
    settings.getModels.mockResolvedValue({
      "gpt-4o-mini": { tier: "light", exposed: true },
      "gpt-5": { tier: "flagship", exposed: true },
      secret: { tier: "flagship", exposed: false },
    });
  });

  it("accepts an exposed model and reports its tier", async () => {
    expect(await ms.gateModel("gpt-4o-mini")).toMatchObject({ ok: true, tier: "light" });
    expect(await ms.gateModel("gpt-5")).toMatchObject({ ok: true, tier: "flagship" });
  });
  it("rejects a hidden model and an unknown id", async () => {
    expect((await ms.gateModel("secret")).ok).toBe(false);
    expect((await ms.gateModel("ghost")).ok).toBe(false);
  });
});

describe("resolveForAction — stale/hidden pick falls back to the default, priced by tier", () => {
  beforeEach(() => {
    settings.getModels.mockResolvedValue({
      "gpt-4o-mini": { tier: "light", exposed: true },
      "gpt-5": { tier: "flagship", exposed: true },
      hidden: { tier: "flagship", exposed: false },
    });
    settings.getCreditCostsForTier.mockImplementation(async (tier) =>
      tier === "flagship" ? { GENERATE_BULLET: 2 } : { GENERATE_BULLET: 1 }
    );
  });

  it("prices a flagship pick at the flagship cost", async () => {
    const r = await ms.resolveForAction({ action: "GENERATE_BULLET", sessionModelId: "gpt-5" });
    expect(r).toMatchObject({ modelId: "gpt-5", tier: "flagship", cost: 2 });
  });

  it("prices scan / summary / skills by the resolved tier (each vertical)", async () => {
    // The tuned per-action flagship costs the chat, scan, summary and skills verticals charge.
    settings.getCreditCostsForTier.mockImplementation(async (tier) =>
      tier === "flagship"
        ? { ANALYSIS: 15, GENERATE_SUMMARY: 5, GENERATE_SKILLS: 10, ARIA_CHAT_MESSAGE: 3 }
        : { ANALYSIS: 10, GENERATE_SUMMARY: 3, GENERATE_SKILLS: 10, ARIA_CHAT_MESSAGE: 1 }
    );
    const flag = (action) => ms.resolveForAction({ action, sessionModelId: "gpt-5" });
    const light = (action) => ms.resolveForAction({ action, sessionModelId: "gpt-4o-mini" });
    expect((await flag("ANALYSIS")).cost).toBe(15);
    expect((await light("ANALYSIS")).cost).toBe(10);
    expect((await flag("GENERATE_SUMMARY")).cost).toBe(5);
    expect((await light("GENERATE_SUMMARY")).cost).toBe(3);
    expect((await flag("ARIA_CHAT_MESSAGE")).cost).toBe(3);
    expect((await light("ARIA_CHAT_MESSAGE")).cost).toBe(1);
  });
  it("a hidden pick degrades to the default (light) rather than hard-failing", async () => {
    const r = await ms.resolveForAction({ action: "GENERATE_BULLET", sessionModelId: "hidden" });
    expect(r.tier).toBe("light");
    expect(r.cost).toBe(1);
  });
});

describe("chargeForModel — flagship ALWAYS meters, light unlimited on paid", () => {
  beforeEach(() => {
    subscription.spendCredits.mockResolvedValue({
      charged: true,
      skipped: false,
      insufficient: false,
      remainingCredits: 5,
    });
    subscription.availableCredits.mockReturnValue(100);
  });

  it("flagship charges even on a paid tier", async () => {
    subscription.isPaidActive.mockReturnValue(true);
    const r = await ms.chargeForModel({}, 5, "flagship", {});
    expect(subscription.spendCredits).toHaveBeenCalledWith({}, 5, {});
    expect(r.charged).toBe(true);
  });

  it("light SKIPS the charge on a paid tier (the unlimited perk)", async () => {
    subscription.isPaidActive.mockReturnValue(true);
    const r = await ms.chargeForModel({}, 5, "light", {});
    expect(subscription.spendCredits).not.toHaveBeenCalled();
    expect(r.skipped).toBe(true);
    expect(r.charged).toBe(false);
  });

  it("light CHARGES on a free tier", async () => {
    subscription.isPaidActive.mockReturnValue(false);
    await ms.chargeForModel({}, 5, "light", {});
    expect(subscription.spendCredits).toHaveBeenCalled();
  });
});
