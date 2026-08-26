// rewriteRoleBullets on claude-sonnet-5 — regression test for a live bug, and the third
// site of the same class as generateSummaryThinking.test.js: the call set neither
// disableThinking nor maxTokens, so Sonnet 5's default adaptive thinking (which shares
// max_tokens with the visible response) ran against callModel's `maxTokens || 1024`
// fallback, ate the budget, and returned JSON truncated mid-object. Every Studio "Edit
// with Aria" rewrite 502'd the moment a user picked the Claude model.
//
// This shape needs more than the constant budget its two siblings use: it ECHOES each
// original bullet back beside its rewrite, so the response scales with the input and the
// budget has to scale with it.
//
// OpenAI stays present (it's what makes ai.service boot as a real, non-"mock" provider on
// require) even though dispatch here — via meta.modelId: "claude-sonnet-5" — only ever
// exercises the Anthropic client. Mirrors generateSummaryThinking.test.js's setup.
process.env.OPENAI_API_KEY = "k-openai";
process.env.ANTHROPIC_API_KEY = "k-anthropic";
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const mockOpenAICreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockOpenAICreate } } }))
);
const mockAnthropicCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicCreate } }))
);
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn().mockResolvedValue({}) }));

const ai = require("../src/services/ai.service");

const BULLETS = [
  "Responsible for managing the monthly reconciliation process",
  "Built a dashboard that cut reporting time from 3 days to 4 hours",
];

const anthropicReplies = (bullets) =>
  mockAnthropicCreate.mockResolvedValue({
    content: [{ text: JSON.stringify({ bullets }) }],
    usage: {},
  });

const rewrite = (over = {}) =>
  ai.rewriteRoleBullets({
    bullets: BULLETS,
    role: "Finance Analyst",
    meta: { modelId: "claude-sonnet-5" },
    ...over,
  });

beforeEach(() => {
  mockAnthropicCreate.mockReset();
  anthropicReplies([
    {
      before: BULLETS[0],
      after: "Owned the monthly reconciliation process end to end",
      changed: true,
      blocked: false,
      blockedReason: "",
    },
    { before: BULLETS[1], after: BULLETS[1], changed: false, blocked: false, blockedReason: "" },
  ]);
});

describe("rewriteRoleBullets — the Claude thinking-budget fix", () => {
  it("disables adaptive thinking so reasoning cannot consume the response budget", async () => {
    await rewrite();

    const arg = mockAnthropicCreate.mock.calls[0][0];
    expect(arg.model).toBe("claude-sonnet-5");
    expect(arg.thinking).toEqual({ type: "disabled" });
  });

  it("sets an explicit budget instead of falling through to the 1024 default", async () => {
    await rewrite();

    const { max_tokens: maxTokens } = mockAnthropicCreate.mock.calls[0][0];
    expect(maxTokens).toBeGreaterThan(1024);
    expect(maxTokens).toBeLessThanOrEqual(8192);
  });

  it("returns the aligned rows rather than throwing a parse error", async () => {
    // The user-visible symptom of the bug: truncated JSON never parsed, so this threw.
    const rows = await rewrite();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ before: BULLETS[0], changed: true, blocked: false });
    expect(rows[1]).toMatchObject({ before: BULLETS[1], after: BULLETS[1], changed: false });
  });

  // The budget must track the input, because every original is echoed back beside its
  // rewrite. A fixed constant would be either wasteful for one bullet or short for ten.
  it("scales the budget with the bullets it has to echo back", async () => {
    await rewrite({ bullets: ["Short one"] });
    const small = mockAnthropicCreate.mock.calls[0][0].max_tokens;

    mockAnthropicCreate.mockClear();
    await rewrite({ bullets: Array.from({ length: 10 }, (_, i) => `${"x".repeat(180)} ${i}`) });
    const large = mockAnthropicCreate.mock.calls[0][0].max_tokens;

    expect(large).toBeGreaterThan(small);
    // ...and stays inside the ceiling no matter how much it is handed.
    expect(large).toBeLessThanOrEqual(8192);
  });

  it("caps the budget for an absurdly long role", async () => {
    await rewrite({ bullets: Array.from({ length: 40 }, () => "y".repeat(600)) });

    expect(mockAnthropicCreate.mock.calls[0][0].max_tokens).toBe(8192);
  });

  // Guards the early return: no bullets means no AI call at all, so no budget question.
  it("never reaches the model when there is nothing to rewrite", async () => {
    const rows = await ai.rewriteRoleBullets({
      bullets: ["", "   ", null],
      role: "Finance Analyst",
      meta: { modelId: "claude-sonnet-5" },
    });

    expect(rows).toEqual([]);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("still surfaces a genuine failure rather than swallowing it", async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ text: "not json at all" }],
      usage: {},
    });

    await expect(rewrite()).rejects.toMatchObject({ name: "AIJSONParseError" });
  });
});
