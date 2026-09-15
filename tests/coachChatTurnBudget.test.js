// coachChatTurn's response budget — regression test for a LIVE, user-visible bug.
//
// A user building a role interview was shown Aria's message as the model's entire raw JSON
// object: `{"reply":"That's an excellent example! ...","intent":"ready","description":"1.
// Carried out routine ...` — cut off mid-word.
//
// The cause was a flat `maxTokens: 700` against an ELEVEN-KEY schema. A wrap-up turn has to
// fill `reply`, a whole `description` of 3-5 finished bullets, a source-quoted `evidence`
// array and `requirementChecks` — 700 could not hold that, the JSON came back incomplete,
// and the controller served the fragment as prose.
//
// It was the fourth site of the Claude thinking-budget class too (see
// rewriteRoleThinking.test.js and generateSummaryThinking.test.js) and the only one of the
// five structured-output callers with neither `disableThinking` nor a test. Two separate
// faults, one line apart — which is why both are pinned here.
//
// NOTE the budget is keyed on `focus`, not on `mustFinish`: the model decides `intent`
// itself and can declare itself ready on any focused turn, so widening only for the FORCED
// wrap-up would still truncate the one the model chose.
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

const PAYLOAD = {
  reply: "Nice — what did that change for the team?",
  intent: "building",
  description: "",
  suggestions: ["I handled ___"],
  exampleAnswers: ["I reconciled the monthly ledger and caught a duplicate payment."],
  suggestionsLabel: "A few ways in:",
  layout: "prose",
  blocks: [],
  evidence: [],
  requirementChecks: [],
};

const FOCUS = { section: "experience", sortId: "s1" };
const MESSAGES = [{ who: "user", text: "I reconciled the monthly ledger" }];

const turn = (over = {}) =>
  ai.coachChatTurn({
    messages: MESSAGES,
    currentStepId: "history",
    focus: FOCUS,
    section: "experience",
    entryTitle: "Accounts Assistant",
    meta: { modelId: "claude-sonnet-5" },
    ...over,
  });

beforeEach(() => {
  mockAnthropicCreate.mockReset();
  mockOpenAICreate.mockReset();
  mockAnthropicCreate.mockResolvedValue({
    content: [{ text: JSON.stringify(PAYLOAD) }],
    usage: {},
    stop_reason: "end_turn",
  });
  mockOpenAICreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(PAYLOAD) }, finish_reason: "stop" }],
    usage: {},
  });
});

describe("the Claude thinking-budget half", () => {
  it("disables adaptive thinking so reasoning cannot eat the response budget", async () => {
    await turn();
    expect(mockAnthropicCreate.mock.calls[0][0].thinking).toEqual({ type: "disabled" });
  });
});

describe("the budget half", () => {
  it("gives a focused turn far more than the 700 that truncated", async () => {
    await turn();
    const { max_tokens: maxTokens } = mockAnthropicCreate.mock.calls[0][0];
    expect(maxTokens).toBeGreaterThan(700);
    // Room for reply + a full description + quoted evidence + requirement checks.
    expect(maxTokens).toBeGreaterThanOrEqual(3000);
  });

  it("widens for EVERY focused turn, not only the forced wrap-up", async () => {
    // The model owns `intent`. A budget that only grew when the server forced the ending
    // would still truncate a `ready` the model reached on its own.
    await turn({ mustFinish: false });
    const ordinary = mockAnthropicCreate.mock.calls[0][0].max_tokens;

    mockAnthropicCreate.mockClear();
    await turn({ mustFinish: true });
    const forced = mockAnthropicCreate.mock.calls[0][0].max_tokens;

    expect(ordinary).toBe(forced);
  });

  it("still sets a real budget on an unfocused general question", async () => {
    // Smaller shape — no description, no evidence — but never the 1024 default, and never
    // small enough to cut a 130-word answer in half.
    await turn({ focus: null });
    const { max_tokens: maxTokens } = mockAnthropicCreate.mock.calls[0][0];
    expect(maxTokens).toBeGreaterThan(1024);
  });

  it("applies on the light model too — this was never Claude-only", async () => {
    // The reported dump happened on "Basic". OpenAI's json_object mode constrains the
    // GRAMMAR, not the LENGTH, so an over-long turn truncates there as well.
    await turn({ meta: { modelId: "gpt-4o-mini" } });
    const { max_tokens: maxTokens } = mockOpenAICreate.mock.calls[0][0];
    expect(maxTokens).toBeGreaterThanOrEqual(3000);
  });
});

describe("a truncated answer is reported as truncated", () => {
  it("marks the parse error so the caller can tell it from prose", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ text: '{"reply":"Here is what I have so f' }],
      usage: {},
      stop_reason: "max_tokens",
    });

    await expect(turn()).rejects.toMatchObject({
      name: "AIJSONParseError",
      truncated: true,
    });
  });

  it("leaves `truncated` false when the model simply answered in prose", async () => {
    // The case the fallback was originally written for: a complete, useful answer that
    // happens not to be JSON. It must keep reaching the user.
    mockAnthropicCreate.mockResolvedValue({
      content: [{ text: "That's a great example — tell me what changed because of it." }],
      usage: {},
      stop_reason: "end_turn",
    });

    await expect(turn()).rejects.toMatchObject({
      name: "AIJSONParseError",
      truncated: false,
    });
  });

  it("reads the OpenAI finish_reason too", async () => {
    mockOpenAICreate.mockResolvedValue({
      choices: [{ message: { content: '{"reply":"cut off here' }, finish_reason: "length" }],
      usage: {},
    });

    await expect(turn({ meta: { modelId: "gpt-4o-mini" } })).rejects.toMatchObject({
      truncated: true,
    });
  });
});
