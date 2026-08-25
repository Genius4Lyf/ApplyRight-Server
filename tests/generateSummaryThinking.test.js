// generateSummaryForStage on claude-sonnet-5 — regression test for a live bug: the summary
// call set maxTokens: 300 with no disableThinking, so Sonnet 5's default adaptive thinking
// (which shares max_tokens with the visible response) could eat the whole budget, truncate
// the JSON mid-object, and turn every "write my summary" attempt into a 502 the moment a
// user picked the Claude model. The fix disables thinking for this short, single-field
// JSON output rather than trying to out-guess its reasoning-token appetite.
// OpenAI stays present (it's what makes ai.service boot as a real, non-"mock" provider on
// require) even though this test's dispatch — via meta.modelId: "claude-sonnet-5" — only
// ever exercises the Anthropic client. Mirrors callModel.test.js's setup.
process.env.OPENAI_API_KEY = "k-openai";
process.env.ANTHROPIC_API_KEY = "k-anthropic";
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const mockOpenAICreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockOpenAICreate } } }))
);
const mockAnthropicCreate = jest.fn().mockResolvedValue({
  content: [{ text: '{"summary": "A concise, tailored professional summary."}' }],
  usage: {},
});
jest.mock("@anthropic-ai/sdk", () =>
  jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicCreate } }))
);
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn().mockResolvedValue({}) }));

const ai = require("../src/services/ai.service");

beforeEach(() => {
  mockAnthropicCreate.mockClear();
});

test("disables adaptive thinking so the response budget isn't silently consumed", async () => {
  const summary = await ai.generateSummaryForStage({
    stage: "experienced",
    role: "Backend Engineer",
    context: "Candidate Name: Jane\nTarget Job Title: Backend Engineer",
    meta: { modelId: "claude-sonnet-5" },
  });

  expect(summary).toBe("A concise, tailored professional summary.");
  const arg = mockAnthropicCreate.mock.calls[0][0];
  expect(arg.model).toBe("claude-sonnet-5");
  expect(arg.thinking).toEqual({ type: "disabled" });
});

test("still surfaces a real failure (does not swallow errors) when the model output is unparseable", async () => {
  mockAnthropicCreate.mockResolvedValueOnce({
    content: [{ text: "not json at all" }],
    usage: {},
  });

  await expect(
    ai.generateSummaryForStage({
      stage: "experienced",
      role: "Backend Engineer",
      context: "Candidate Name: Jane\nTarget Job Title: Backend Engineer",
      meta: { modelId: "claude-sonnet-5" },
    })
  ).rejects.toMatchObject({ name: "AIJSONParseError" });
});
