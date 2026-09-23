// The skills reply budget — regression test for a LIVE production failure.
//
//   AI Skills Generation Failed: SyntaxError: Expected ',' or ']' after array element
//   in JSON at position 12408 (line 210 column 10)
//       at Object.generateSkillsFromContext (ai.service.js:6094)
//
// Reported at a chosen ceiling of 20 skills on the Expert model, and deterministic there.
//
// Two faults, one line apart:
//
//  1. `maxTokens: isPaid ? 8192 : 4096` — a CONSTANT. The user picks 10 / 15 / 20 on the
//     card, that number reached the prompt as `skillTarget` and nothing else, so asking
//     for twenty skills got exactly the room of asking for ten. Measured against the
//     documented output shape, a ceiling of 20 needs ~8,122 output tokens on the free
//     shape and ~9,535 on the paid one — the old free budget was already short at the
//     DEFAULT of 15, and half of what 20 needs.
//
//  2. The recovery path could not recover this. `AIJSONParseError` already carries
//     `truncated` (set from Anthropic's `stop_reason === "max_tokens"`), and the catch
//     discarded it and fell through to the tolerant brace-slice. On a truncated reply
//     `lastIndexOf("}")` finds the last complete INNER object and slices to it, yielding
//     an object whose arrays are opened and never closed — a parse that CANNOT succeed,
//     raising a SyntaxError that names a position 12kB away from the cause.
//
// Nothing was ever charged for this (the controller's 502 AI_FAILED path runs before
// `chargeForModel`), so the cost was the wasted call and a retry that failed identically.
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

const EDUCATION = [{ degree: "OND", field: "Electrical Engineering", school: "Yabatech" }];
const EXPERIENCE = [
  {
    _sortId: "e1",
    title: "Maintenance Technician",
    company: "Dangote",
    description: "Serviced pumps and compressors on a rota; raised permits before isolation.",
  },
];
const PROJECTS = [];

// A canon row is what makes `confirmTarget` scale with the ceiling instead of sitting at 5.
const CANON = [
  {
    id: "exp0",
    label: "Maintenance Technician",
    source: "experience",
    skills: [{ name: "Vibration analysis" }, { name: "Permit-to-Work" }],
  },
];

const GOOD_PAYLOAD = {
  suggestions: [
    {
      category: "Technical & Engineering Skills",
      skills: ["Preventive Maintenance"],
      skillsDetailed: [
        {
          name: "Preventive Maintenance",
          evidence: [
            { type: "experience", refIndex: 0, snippet: "Serviced pumps and compressors" },
          ],
        },
      ],
    },
  ],
  confirmationCandidates: [],
};

const anthropicReply = (payload, stopReason = "end_turn") => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  stop_reason: stopReason,
  usage: { input_tokens: 1200, output_tokens: 400 },
});

const generate = (options) =>
  ai.generateSkillsFromContext(EDUCATION, EXPERIENCE, PROJECTS, "Technician wanted", false, {
    modelId: "claude-sonnet-5",
    meta: { operation: "generateSkills" },
    ...options,
  });

const budgetOf = (call) => call[0].max_tokens;

beforeEach(() => {
  jest.clearAllMocks();
  mockAnthropicCreate.mockResolvedValue(anthropicReply(GOOD_PAYLOAD));
});

describe("skillsOutputBudget — the shape decides the room", () => {
  // The measured worst case of the documented output shape, pretty-printed at ~3.2
  // chars/token. These are the numbers the constants were chosen against; if the shape
  // grows a field, this is the test that should fail.
  const MEASURED = {
    free10: 4085,
    free15: 6104,
    free20: 8122,
    paid20: 9535,
  };

  it("grows with the ceiling the user picked", () => {
    const at = (skillTarget) =>
      ai.skillsOutputBudget({ skillTarget, confirmTarget: skillTarget, isPaid: false });
    expect(at(20)).toBeGreaterThan(at(15));
    expect(at(15)).toBeGreaterThan(at(10));
  });

  it("covers the measured worst case at every rung", () => {
    expect(
      ai.skillsOutputBudget({ skillTarget: 10, confirmTarget: 10, isPaid: false })
    ).toBeGreaterThanOrEqual(MEASURED.free10);
    expect(
      ai.skillsOutputBudget({ skillTarget: 15, confirmTarget: 15, isPaid: false })
    ).toBeGreaterThanOrEqual(MEASURED.free15);
    expect(
      ai.skillsOutputBudget({ skillTarget: 20, confirmTarget: 20, isPaid: false })
    ).toBeGreaterThanOrEqual(MEASURED.free20);
    expect(
      ai.skillsOutputBudget({ skillTarget: 20, confirmTarget: 20, isPaid: true })
    ).toBeGreaterThanOrEqual(MEASURED.paid20);
  });

  it("leaves ~15% over the measurement, because French runs longer than the English it was measured in", () => {
    const free20 = ai.skillsOutputBudget({ skillTarget: 20, confirmTarget: 20, isPaid: false });
    expect(free20).toBeGreaterThanOrEqual(Math.ceil(MEASURED.free20 * 1.15));
  });

  it("the paid shape gets more room than the free one for the same ceiling", () => {
    expect(
      ai.skillsOutputBudget({ skillTarget: 20, confirmTarget: 20, isPaid: true })
    ).toBeGreaterThan(ai.skillsOutputBudget({ skillTarget: 20, confirmTarget: 20, isPaid: false }));
  });

  it("never drops below the constants it replaced — this may not be a regression for anyone", () => {
    expect(
      ai.skillsOutputBudget({ skillTarget: 5, confirmTarget: 0, isPaid: false })
    ).toBeGreaterThanOrEqual(4096);
    expect(
      ai.skillsOutputBudget({ skillTarget: 5, confirmTarget: 0, isPaid: true })
    ).toBeGreaterThanOrEqual(8192);
  });

  it("bounds a runaway", () => {
    expect(
      ai.skillsOutputBudget({ skillTarget: 999, confirmTarget: 999, isPaid: true })
    ).toBeLessThanOrEqual(16000);
  });

  it("clamps junk the way the prompt's own skillTarget does", () => {
    const fallback = ai.skillsOutputBudget({
      skillTarget: undefined,
      confirmTarget: 5,
      isPaid: false,
    });
    // undefined → the same default of 15 the prompt uses
    expect(fallback).toBe(
      ai.skillsOutputBudget({ skillTarget: 15, confirmTarget: 5, isPaid: false })
    );
  });
});

describe("the budget reaches the model", () => {
  it("asking for 20 buys more room than asking for 10", async () => {
    await generate({ count: 10, roleCanon: CANON });
    const atTen = budgetOf(mockAnthropicCreate.mock.calls[0]);

    mockAnthropicCreate.mockClear();
    await generate({ count: 20, roleCanon: CANON });
    const atTwenty = budgetOf(mockAnthropicCreate.mock.calls[0]);

    expect(atTwenty).toBeGreaterThan(atTen);
    // The reported failure: 20 must clear the shape it was asked for.
    expect(atTwenty).toBeGreaterThanOrEqual(8122);
  });

  it("still sends the request the user's ceiling asked for", async () => {
    await generate({ count: 20, roleCanon: CANON });
    expect(mockAnthropicCreate.mock.calls[0][0].messages[0].content).toContain("UP TO 20");
  });

  it("keeps thinking off, so the budget is all visible output", async () => {
    await generate({ count: 20, roleCanon: CANON });
    const body = mockAnthropicCreate.mock.calls[0][0];
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});

describe("a truncated reply fails on its real cause", () => {
  // The exact failure mode: valid-looking JSON cut mid-array, with the stop reason that
  // says why. Feeding this to the brace-slice is what produced the reported SyntaxError.
  const TRUNCATED =
    '{"suggestions":[{"category":"Technical","skills":["A","B"],"skillsDetailed":[' +
    '{"name":"A","evidence":[{"type":"experience","refIndex":0,"snippet":"did a thing"}]},' +
    '{"name":"B","evidence":[{"type":"experience","refIndex":0,"snippet":"did another"}]';

  it("reports failure rather than throwing a parse error from 12kB away", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: TRUNCATED }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1200, output_tokens: 8192 },
    });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    const out = await generate({ count: 20, roleCanon: CANON });

    expect(out).toEqual({ suggestions: [], confirmationCandidates: [], failed: true });
    // `failed` is what the controller turns into a retryable 502 with nothing charged.
    const logged = spy.mock.calls.map((args) => String(args[1]?.message || args[1])).join(" ");
    expect(logged).toContain("output cap");
    expect(logged).not.toContain("Expected");
    spy.mockRestore();
  });

  it("a reply wrapped in PROSE is still recovered — the brace-slice keeps its real job", async () => {
    mockAnthropicCreate.mockResolvedValue({
      content: [
        { type: "text", text: `Here you go!\n${JSON.stringify(GOOD_PAYLOAD)}\nHope that helps.` },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1200, output_tokens: 400 },
    });

    const out = await generate({ count: 20, roleCanon: CANON });

    expect(out.failed).toBeUndefined();
    expect(out.suggestions.length).toBeGreaterThan(0);
  });
});
