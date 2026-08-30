// Anthropic rejects a system block that carries cache_control but no text:
//   400 invalid_request_error — "system.0: cache_control cannot be set for empty text blocks"
//
// Every other caller of callModel supplies a system prompt, so the empty case never
// existed until skills generation — which puts its ENTIRE prompt in `user` — was allowed
// to reach a Claude model through the per-action Pro picker. On English, langDirective is
// a no-op, so `system` was exactly "" and every Pro skills generation 400'd instantly.
//
// The fix is in callModel rather than in the caller, because the next caller to omit a
// system prompt would hit exactly the same wall.
process.env.ANTHROPIC_API_KEY = "k-anthropic";
process.env.OPENAI_API_KEY = "k-openai";

const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicCreate } }))
);
jest.mock("openai", () => jest.fn().mockImplementation(() => ({ chat: { completions: {} } })));
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn().mockResolvedValue({}) }));

const ai = require("../src/services/ai.service");

const reply = (text) => ({
  content: [{ text }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

const sentBody = () => mockAnthropicCreate.mock.calls[0][0];

beforeEach(() => mockAnthropicCreate.mockReset());

describe("callModel on Anthropic", () => {
  it("omits the system block entirely when there is no system prompt", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(reply("hello"));

    await ai.callModel("claude-sonnet-5", { user: "Say hello", meta: {} });

    // Not "an empty system block" — no system field at all. An empty array or an empty
    // text block would each be rejected in their own way.
    expect(sentBody().system).toBeUndefined();
  });

  it("still caches a real system prompt — the margin lever is untouched", async () => {
    mockAnthropicCreate.mockResolvedValueOnce(reply("hello"));

    await ai.callModel("claude-sonnet-5", {
      system: "You are a recruiter.",
      user: "Say hello",
      meta: {},
    });

    expect(sentBody().system).toEqual([
      {
        type: "text",
        text: expect.stringContaining("You are a recruiter."),
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("survives the exact shape skills generation sends", async () => {
    // Whole prompt in `user`, JSON mode, no system. This is the call that 400'd in
    // production the moment the Pro picker was offered on skills.
    mockAnthropicCreate.mockResolvedValueOnce(reply(JSON.stringify({ suggestions: [] })));

    const out = await ai.callModel("claude-sonnet-5", {
      user: "OUTPUT STRICT JSON: { }",
      json: true,
      disableThinking: true,
      maxTokens: 4096,
      meta: { operation: "generateSkills" },
    });

    expect(out).toEqual({ suggestions: [] });
    expect(sentBody().system).toBeUndefined();
  });
});
