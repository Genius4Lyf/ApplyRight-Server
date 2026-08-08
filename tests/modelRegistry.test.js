// Model registry (config/catalog) + per-tier cost resolver (settings.service) + the
// missing-key fallback in ai.resolveModelCall. SystemSettings is mocked so the resolver
// returns pure defaults; an OpenAI key is set so ai.service boots on the openai provider.
process.env.OPENAI_API_KEY = "test-openai-key";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MOONSHOT_API_KEY;

jest.mock("../src/models/SystemSettings");

const catalog = require("../src/config/catalog");
const SystemSettings = require("../src/models/SystemSettings");
const settings = require("../src/services/settings.service");
const ai = require("../src/services/ai.service");

describe("model registry (config/catalog)", () => {
  it("resolves provider + apiModel + tier for a model id", () => {
    const row = catalog.modelFrom(catalog.DEFAULT_MODELS, "claude-sonnet-5");
    expect(row.provider).toBe("anthropic");
    expect(row.apiModel).toBe("claude-sonnet-5");
    expect(catalog.tierOfModel(catalog.DEFAULT_MODELS, "claude-sonnet-5")).toBe("flagship");
    expect(catalog.tierOfModel(catalog.DEFAULT_MODELS, "gpt-4o-mini")).toBe("light");
    expect(catalog.tierOfModel(catalog.DEFAULT_MODELS, "deepseek-v4-flash")).toBe("light");
  });

  it("has exactly two tiers and NO reasoning/opus models", () => {
    const tiers = new Set(Object.values(catalog.DEFAULT_MODELS).map((m) => m.tier));
    expect([...tiers].sort()).toEqual(["flagship", "light"]);
    const ids = Object.keys(catalog.DEFAULT_MODELS).join(" ");
    expect(ids).not.toMatch(/opus|o1|o3|reason/i);
  });

  it("unknown model id resolves to the DEFAULT_MODEL row / light tier", () => {
    expect(catalog.modelFrom(catalog.DEFAULT_MODELS, "nope").apiModel).toBe(
      catalog.DEFAULT_MODELS[catalog.DEFAULT_MODEL].apiModel
    );
    expect(catalog.tierOfModel(catalog.DEFAULT_MODELS, "nope")).toBe("light");
    expect(catalog.DEFAULT_MODEL).toBe("gpt-4o-mini"); // light default (OpenAI — always-satisfiable key)
  });
});

describe("per-(action, tier) credit cost resolver", () => {
  beforeEach(() => {
    settings.invalidateCreditCostsCache();
    SystemSettings.getInstance = jest
      .fn()
      .mockResolvedValue({ creditCosts: {}, flagshipCreditCosts: {}, models: {} });
  });

  it("light = today's costs", async () => {
    const light = await settings.getCreditCostsForTier("light");
    expect(light.ARIA_CHAT_MESSAGE).toBe(1);
    expect(light.ANALYSIS).toBe(10);
    expect(light.GENERATE_BULLET).toBe(1);
    expect(light.GENERATE_SUMMARY).toBe(3);
    expect(light.GENERATE_SKILLS).toBe(10);
    expect(light.DRAFT_JD).toBe(1);
  });

  it("flagship = tuned deltas, inheriting light for the rest", async () => {
    const f = await settings.getCreditCostsForTier("flagship");
    expect(f.ARIA_CHAT_MESSAGE).toBe(10); // chat 1 → 10
    expect(f.ANALYSIS).toBe(15); // scan 10 → 15
    expect(f.GENERATE_BULLET).toBe(2); // bullet 1 → 2
    expect(f.GENERATE_SUMMARY).toBe(5); // summary 3 → 5
    expect(f.GENERATE_SKILLS).toBe(15); // skills 10 → 15
    // DRAFT_JD has NO flagship delta by design, so it falls through the sparse delta map
    // and inherits the light cost. It's also server-pinned to the light model in
    // studio.controller.draftJd, so it can never resolve to a flagship price.
    const light = await settings.getCreditCostsForTier("light");
    expect(f.DRAFT_JD).toBe(light.DRAFT_JD);
  });

  it("getModels returns the exposed defaults", async () => {
    const models = await settings.getModels();
    expect(models["gpt-5"].tier).toBe("flagship");
    expect(models["gpt-4o-mini"].exposed).toBe(true);
    expect(models["claude-sonnet-5"].provider).toBe("anthropic");
  });
});

describe("ai.resolveModelCall — missing-key fallback (never mock)", () => {
  it("uses the selected model when its provider key is present", () => {
    const r = ai.resolveModelCall("gpt-4o"); // openai key IS set
    expect(r.provider).toBe("openai");
    expect(r.apiModel).toBe("gpt-4o");
    expect(r.fellBack).toBeUndefined();
  });

  it("falls back to DEFAULT_MODEL when the selected provider key is missing", () => {
    const r = ai.resolveModelCall("claude-sonnet-5"); // no ANTHROPIC key
    expect(r.provider).toBe("openai");
    expect(r.apiModel).toBe("gpt-4o-mini"); // DEFAULT_MODEL's apiModel
    expect(r.fellBack).toBe(true);
  });
});

