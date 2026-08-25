// generateBulletsFromDescription's citation-enforcement + backfill retry — the mechanism
// behind the "asked for 5, only got 2" bug. Once a verified evidence ledger exists, a
// bullet with no valid evidenceIds is dropped; this used to just return whatever survived.
// Now one bounded backfill call tops the result back up toward `count` before giving up.
//
// The OpenAI SDK is mocked (mirrors callModel.test.js) so the real callModel/callJSON
// dispatch chain runs unmocked — this exercises the actual retry logic, not a stand-in.
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

const respond = (bullets) => ({
  choices: [{ message: { content: JSON.stringify({ bullets }) } }],
  usage: {},
});

const LEDGER = {
  evidence: [
    { id: "ev_1", claim: "Cut latency", sourceQuote: "I cut checkout latency." },
    { id: "ev_2", claim: "Fixed cart bugs", sourceQuote: "I fixed cart-abandonment bugs." },
  ],
};

const baseOptions = (over = {}) => ({
  role: "Backend Engineer",
  evidenceLedger: LEDGER,
  returnDetails: true,
  meta: { modelId: "gpt-4o-mini" },
  ...over,
});

beforeEach(() => {
  mockOpenAICreate.mockClear();
  mockOpenAICtor.mockClear();
});

describe("generateBulletsFromDescription — citation backfill", () => {
  it("backfills the shortfall in ONE extra call when some bullets fail citation", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(
        respond([
          { text: "Cut checkout latency 30%", evidenceIds: ["ev_1"] },
          { text: "Improved deploy speed", evidenceIds: [] }, // uncited — dropped
          { text: "Refactored the API layer", evidenceIds: [] }, // uncited — dropped
        ])
      )
      .mockResolvedValueOnce(
        respond([
          { text: "Resolved recurring cart-abandonment bugs", evidenceIds: ["ev_2"] },
          { text: "Streamlined the payment call path", evidenceIds: ["ev_2"] },
        ])
      );

    const details = await ai.generateBulletsFromDescription(
      "Worked on checkout performance and cart bugs.",
      3,
      baseOptions()
    );

    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    expect(details).toHaveLength(3);
    expect(details.map((d) => d.text)).toEqual([
      "Cut checkout latency 30%",
      "Resolved recurring cart-abandonment bugs",
      "Streamlined the payment call path",
    ]);

    // The retry asked for exactly the shortfall (3 requested − 1 survived = 2), and told
    // the model what was already written so it doesn't repeat a facet.
    const retryArg = mockOpenAICreate.mock.calls[1][0];
    const retryUserMsg = retryArg.messages.find((m) => m.role === "user").content;
    expect(retryUserMsg).toContain("Write EXACTLY 2 distinct bullets");
    expect(retryUserMsg).toContain("ALREADY WRITTEN");
    expect(retryUserMsg).toContain("Cut checkout latency 30%");
  });

  it("returns fewer than requested (never more than one retry) when the backfill also falls short", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(
        respond([{ text: "Cut checkout latency 30%", evidenceIds: ["ev_1"] }])
      )
      .mockResolvedValueOnce(
        respond([
          { text: "Fixed a bug", evidenceIds: [] }, // still uncited
          { text: "Also fixed a bug", evidenceIds: [] },
        ])
      );

    const details = await ai.generateBulletsFromDescription(
      "Worked on checkout performance.",
      4,
      baseOptions()
    );

    expect(mockOpenAICreate).toHaveBeenCalledTimes(2); // no third attempt
    expect(details).toHaveLength(1);
    expect(details[0].text).toBe("Cut checkout latency 30%");
  });

  it("skips filtering and backfill entirely when there is no evidence ledger", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      respond([
        { text: "Bullet one", evidenceIds: [] },
        { text: "Bullet two", evidenceIds: [] },
        { text: "Bullet three", evidenceIds: [] },
      ])
    );

    const details = await ai.generateBulletsFromDescription("Worked on stuff.", 3, {
      ...baseOptions(),
      evidenceLedger: null,
    });

    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(details).toHaveLength(3);
  });

  // The clamp inside generateBulletsFromDescription must match the controller's own
  // bound (1–8). If it lags behind, a legitimate 8 request is silently truncated to a
  // stale ceiling with no error — the user pays for 8 and sees fewer.
  it("asks the model for all 8 when 8 are requested", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      respond(
        Array.from({ length: 8 }, (_, i) => ({ text: `Bullet ${i + 1}`, evidenceIds: ['ev_1'] }))
      )
    );

    const details = await ai.generateBulletsFromDescription(
      'Worked across the whole checkout stack.',
      8,
      baseOptions()
    );

    expect(details).toHaveLength(8);
    const userMsg = mockOpenAICreate.mock.calls[0][0].messages.find((m) => m.role === 'user')
      .content;
    expect(userMsg).toContain('Write EXACTLY 8 distinct bullets');
  });

  it("does not exceed the requested count when the first call over-delivers", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      respond([
        { text: "Bullet one", evidenceIds: ["ev_1"] },
        { text: "Bullet two", evidenceIds: ["ev_1"] },
        { text: "Bullet three", evidenceIds: ["ev_1"] },
      ])
    );

    const details = await ai.generateBulletsFromDescription("Worked on stuff.", 2, baseOptions());

    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(details).toHaveLength(2);
  });
});

// The writer used to be entirely stage-blind: Aria could interview a student gently and
// then hand the transcript to this function, which had never heard of career stage.
describe("generateBulletsFromDescription — career stage reaches the writer", () => {
  const userPrompt = () =>
    mockOpenAICreate.mock.calls[0][0].messages.find((m) => m.role === "user").content;

  beforeEach(() => {
    mockOpenAICreate.mockResolvedValue(
      respond([{ text: "Built the class booking tool", evidenceIds: ["ev_1"] }])
    );
  });

  it("carries the grad directive, and no metric pressure with it", async () => {
    await ai.generateBulletsFromDescription("Built a booking tool for my class.", 1, {
      ...baseOptions(),
      stage: "grad",
    });

    const user = userPrompt();
    expect(user).toMatch(/CANDIDATE STAGE/);
    expect(user).toMatch(/START of their career/i);
    expect(user).toMatch(/do NOT reach for a business metric/i);
    expect(user).toMatch(/EXECUTION LEVEL/);
  });

  it("uses the PROJECT section note when the section is a project", async () => {
    await ai.generateBulletsFromDescription("Built a booking tool.", 1, {
      ...baseOptions(),
      section: "project",
      stage: "grad",
    });

    expect(userPrompt()).toMatch(/SECTION NOTE — PROJECTS/);
  });

  it("stays byte-identical to the old behaviour when no stage is resolved", async () => {
    await ai.generateBulletsFromDescription("Did the thing.", 1, baseOptions());
    expect(userPrompt()).not.toMatch(/CANDIDATE STAGE/);
  });

  // briefContextBlock injects the JOB's seniority into the same prompt. It used to say
  // "match bullet authority/scope to this level", which told the model to write a grad up
  // to a senior posting — the one instruction in the file that asked for inflation.
  it("defuses the seniority conflict instead of asking the model to referee it", async () => {
    await ai.generateBulletsFromDescription("Built a booking tool.", 1, {
      ...baseOptions(),
      stage: "grad",
      brief: { role: "Analyst", company: "Acme", seniority: "senior", requirements: [] },
    });

    const user = userPrompt();
    expect(user).toMatch(/CONFLICT NOTICE/);
    expect(user).toMatch(/the JOB's level, not the candidate's/);
    expect(user).not.toMatch(/match bullet authority\/scope to this level/);
  });
});
