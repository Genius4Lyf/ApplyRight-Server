// callModel dispatch — the multi-provider router picks the right client + apiModel per
// provider. The provider SDKs are mocked so no network is hit; keys are set so each
// provider is reachable (no fallback). Vars are `mock`-prefixed so Jest lets the mock
// factories reference them despite hoisting.
process.env.OPENAI_API_KEY = "k-openai";
process.env.ANTHROPIC_API_KEY = "k-anthropic";
process.env.DEEPSEEK_API_KEY = "k-deepseek";
delete process.env.GEMINI_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const mockOpenAICreate = jest
  .fn()
  .mockResolvedValue({ choices: [{ message: { content: "openai-out" } }], usage: {} });
const mockAnthropicCreate = jest
  .fn()
  .mockResolvedValue({ content: [{ text: "anthropic-out" }], usage: {} });
const mockLogCreate = jest.fn().mockResolvedValue({});

// The OpenAI SDK is a default-exported class; both openai and the OpenAI-compatible
// providers (deepseek/moonshot) construct it. Capture the constructor options so we can
// assert deepseek got its baseURL.
const mockOpenAICtor = jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockOpenAICreate } },
}));
jest.mock("openai", () => mockOpenAICtor);
jest.mock("@anthropic-ai/sdk", () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicCreate } }))
);
jest.mock("../src/models/AICallLog", () => ({ create: mockLogCreate }));

const ai = require("../src/services/ai.service");

beforeEach(() => {
  mockOpenAICreate.mockClear();
  mockAnthropicCreate.mockClear();
  mockOpenAICtor.mockClear();
  mockLogCreate.mockClear();
});

describe("callModel — routes to the correct provider client", () => {
  it("an OpenAI model → openai chat.completions with its apiModel", async () => {
    const out = await ai.callModel("gpt-4o", { user: "hi" });
    expect(out).toBe("openai-out");
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o" })
    );
  });

  it("claude-sonnet-5 → anthropic messages.create with prompt caching on the system block", async () => {
    const out = await ai.callModel("claude-sonnet-5", { system: "SYS", user: "hi" });
    expect(out).toBe("anthropic-out");
    const arg = mockAnthropicCreate.mock.calls[0][0];
    expect(arg.model).toBe("claude-sonnet-5");
    expect(arg.temperature).toBeUndefined();
    expect(arg.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("a DeepSeek (OpenAI-compatible) model → OpenAI SDK constructed with the DeepSeek baseURL", async () => {
    await ai.callModel("deepseek-v4-flash", { user: "hi" });
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek-chat" })
    );
    // The client for deepseek is built with its baseURL (not the plain openai client).
    const builtWithBaseUrl = mockOpenAICtor.mock.calls.some(
      (c) => c[0] && /deepseek/.test(c[0].baseURL || "")
    );
    expect(builtWithBaseUrl).toBe(true);
  });

  it("a model whose provider key is missing FALLS BACK to the default (openai), never mock", async () => {
    // MOONSHOT_API_KEY is unset → kimi falls back to DEFAULT_MODEL (gpt-4o-mini / openai).
    await ai.callModel("kimi-k2.5", { user: "hi" });
    expect(mockOpenAICreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" })
    );
  });
});
