// OPENAI'S REASONING MODELS TAKE A DIFFERENT PARAMETER SHAPE.
//
// From the production log, within hours of exposing gpt-5-mini as the Advanced tier:
//
//   Coach chat AI error: 400 Unsupported parameter: 'max_tokens' is not supported with
//   this model. Use 'max_completion_tokens' instead.
//   POST /api/coach/chat 502
//
// Every Advanced turn failed. GPT-5 and the o-series refuse `max_tokens`, and accept only
// the default for the sampling controls — so `temperature` has to be omitted rather than
// set. Both are hard 400s: there is no partial success to notice in testing, which is
// also why the tier's own unit tests were all green while the feature was unusable.
//
// The SDK is mocked (same harness as generateBulletsBackfill.test.js) so the real
// callModel/callJSON dispatch runs and these assert the body that actually goes out.
process.env.OPENAI_API_KEY = "k-openai";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const mockOpenAICreate = jest.fn();
const mockOpenAICtor = jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockOpenAICreate } },
}));
jest.mock("openai", () => mockOpenAICtor);
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn().mockResolvedValue({}) }));

const ai = require("../src/services/ai.service");

const respond = (payload) => ({
  choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
  usage: {},
});

const body = () => mockOpenAICreate.mock.calls[0][0];

// Driven through a real feature rather than the private helper, so this covers the
// dispatch path a request actually takes.
const generateOn = (modelId) =>
  ai.generateBulletsFromDescription("I greased the sheaves before every rig-up.", 1, {
    role: "Wireline Field Operator",
    returnDetails: true,
    meta: { modelId },
  });

beforeEach(() => {
  mockOpenAICreate.mockReset();
  mockOpenAICreate.mockResolvedValue(respond({ bullets: [{ text: "A bullet", evidenceIds: [] }] }));
});

describe("what goes on the wire for a reasoning model", () => {
  it("sends max_completion_tokens, never max_tokens", async () => {
    await generateOn("gpt-5-mini");

    expect(body()).toHaveProperty("max_completion_tokens");
    expect(body()).not.toHaveProperty("max_tokens");
  });

  // The other half of the same 400, and the one that would have bitten immediately after
  // fixing the first: these models accept only the default sampling values.
  it("omits temperature rather than setting it", async () => {
    await generateOn("gpt-5-mini");
    expect(body()).not.toHaveProperty("temperature");
  });

  // Reasoning tokens never appear in the reply but come out of the SAME allowance, so a
  // budget sized for visible output alone can be spent entirely on thinking and return an
  // empty string — a quieter failure than the 400 and a worse one to diagnose.
  it("floors the budget so thinking cannot starve the answer", async () => {
    await generateOn("gpt-5-mini");
    expect(body().max_completion_tokens).toBeGreaterThanOrEqual(4000);
  });

  it("keeps structured output on, which these models do support", async () => {
    await generateOn("gpt-5-mini");
    expect(body().response_format).toEqual({ type: "json_object" });
  });
});

describe("every other model is untouched", () => {
  it("still sends max_tokens and temperature on gpt-4o-mini", async () => {
    await generateOn("gpt-4o-mini");

    expect(body()).toHaveProperty("max_tokens");
    expect(body()).not.toHaveProperty("max_completion_tokens");
    expect(typeof body().temperature).toBe("number");
  });

  // DeepSeek and Moonshot are OpenAI-COMPATIBLE, not OpenAI. They share the branch and
  // must keep the ordinary shape — switching them would break two providers to fix one.
  it("leaves an OpenAI-compatible provider on the ordinary shape", async () => {
    process.env.DEEPSEEK_API_KEY = "k-deepseek";
    jest.resetModules();
    const fresh = require("../src/services/ai.service");
    mockOpenAICreate.mockResolvedValue(
      respond({ bullets: [{ text: "A bullet", evidenceIds: [] }] })
    );

    await fresh.generateBulletsFromDescription("I did the work.", 1, {
      role: "Engineer",
      returnDetails: true,
      meta: { modelId: "deepseek-v4-flash" },
    });

    expect(body()).toHaveProperty("max_tokens");
    expect(body()).not.toHaveProperty("max_completion_tokens");
    delete process.env.DEEPSEEK_API_KEY;
  });
});

// THE "DON'T THINK ABOUT IT" FLAG WAS SILENTLY INERT ON THESE MODELS.
//
// Reported: on Advanced, bullet generation errored; switching to Basic worked. Chat was
// fine, which is what made it confusing — the parameter-name fix above had landed.
//
// `disableThinking` has always meant "this is a short structured-output task, do not spend
// the budget working up to it". Anthropic gets thinking:{type:"disabled"}. OpenAI's
// reasoning models got NOTHING — the flag was read, passed around, and dropped.
//
// Bullet generation is where it had to surface: 4,096 tokens, a structured object, and a
// comment in the generator itself saying truncated JSON is a hard failure. Reasoning ate
// the budget, the JSON came back cut in half, and the turn 502'd. A chat reply is prose
// and short, so it survived on the same budget.
describe("disableThinking reaches the reasoning models too", () => {
  it("maps it to the lowest reasoning effort", async () => {
    mockOpenAICreate.mockResolvedValue(
      respond({ bullets: [{ text: "A bullet", evidenceIds: [] }] })
    );
    // generateBulletsFromDescription sets disableThinking: true — the caller this broke.
    await generateOn("gpt-5-mini");

    expect(body().reasoning_effort).toBe("low");
  });

  // NO TEST FOR THE OTHER BRANCH, DELIBERATELY. Every caller that routes through the
  // model picker sets disableThinking today — bullets, chat, summary, skills are all
  // short structured output — so "full reasoning on a reasoning model" has no live
  // caller to drive it from. A test would have to invent one, and a test that exercises
  // a hypothetical proves only that the hypothetical was written down. (The first draft
  // of this file did exactly that, asserted the wrong thing about coachChatTurn, and
  // failed.) The gating that DOES have both branches is the model, covered below.

  it("never sends it to a model that would reject it", async () => {
    mockOpenAICreate.mockResolvedValue(
      respond({ bullets: [{ text: "A bullet", evidenceIds: [] }] })
    );
    await generateOn("gpt-4o-mini");

    expect(body()).not.toHaveProperty("reasoning_effort");
  });

  // The budget floor and the effort cap are two halves of one fix: the cap stops reasoning
  // running away, the floor leaves room for what it does spend. Either alone still
  // truncates a structured object.
  it("keeps enough headroom for a structured object", async () => {
    mockOpenAICreate.mockResolvedValue(
      respond({ bullets: [{ text: "A bullet", evidenceIds: [] }] })
    );
    await generateOn("gpt-5-mini");

    expect(body().max_completion_tokens).toBeGreaterThanOrEqual(6000);
  });
});
