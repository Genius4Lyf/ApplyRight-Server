// NOT WRITING A BULLET THE ROLE ALREADY HAS.
//
// Applying bullets is a checkpoint, not an ending: the user carries on about the same
// role, the coach's transcript restarts at the fresh pin, and the writer used to receive
// nothing at all saying what the first round had produced. Measured on a real CV — a
// Wireline Field Operator role with 40 applied bullets where #33–#38 are near-copies of
// #9–#16, and the same expired-certification catch is told three times.
//
// Two mechanisms, because one is not enough:
//   · the existing bullets go INTO the prompt, which is what actually changes the output;
//   · anything that comes back substantially the same anyway is DROPPED, because an
//     instruction is not a guarantee and a duplicate that slips through is charged for.
//
// The OpenAI SDK is mocked (same harness as generateBulletsBackfill.test.js) so the real
// callModel/callJSON chain runs — this exercises the shipped path, not a stand-in.
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

// Real lines from the role that surfaced this.
const ON_CV = [
  "Handed off serviced equipment to specialists for FIT checks, ensuring units and tools were verified ready before the next job.",
  "Identified and reported equipment faults immediately through the company-approved system, enabling timely follow-up by the Equipment Readiness team.",
];

const opts = (over = {}) => ({
  role: "Wireline Field Operator",
  returnDetails: true,
  existingBullets: ON_CV,
  meta: { modelId: "gpt-4o-mini" },
  ...over,
});

const userMsg = (callIndex = 0) =>
  mockOpenAICreate.mock.calls[callIndex][0].messages.find((m) => m.role === "user").content;

beforeEach(() => {
  mockOpenAICreate.mockReset();
});

describe("the writer is shown what the entry already claims", () => {
  it("puts the existing bullets in the prompt under their own heading", async () => {
    mockOpenAICreate.mockResolvedValueOnce(respond([{ text: "Something new", evidenceIds: [] }]));
    await ai.generateBulletsFromDescription("I greased the sheaves.", 1, opts());

    const sent = userMsg();
    expect(sent).toContain("ALREADY ON THIS ROLE");
    expect(sent).toContain("verified ready before the next job");
    expect(sent).toContain("Equipment Readiness team");
  });

  it("says PROJECT when the entry is a project", async () => {
    mockOpenAICreate.mockResolvedValueOnce(respond([{ text: "Something new", evidenceIds: [] }]));
    await ai.generateBulletsFromDescription("I built it.", 1, opts({ section: "project" }));

    expect(userMsg()).toContain("ALREADY ON THIS PROJECT");
  });

  it("adds no heading at all for an entry with no bullets yet", async () => {
    mockOpenAICreate.mockResolvedValueOnce(respond([{ text: "Something new", evidenceIds: [] }]));
    await ai.generateBulletsFromDescription(
      "I greased the sheaves.",
      1,
      opts({
        existingBullets: [],
      })
    );

    expect(userMsg()).not.toContain("ALREADY ON THIS");
  });
});

describe("a bullet that comes back as a restatement is dropped anyway", () => {
  it("drops a near-copy of a bullet already on the entry", async () => {
    // Close enough to #35 in the real CV: same handoff, same FIT checks, reworded.
    mockOpenAICreate.mockResolvedValueOnce(
      respond([
        {
          text: "Handed off serviced equipment to specialists for FIT checks following maintenance work, confirming readiness before the next job.",
          evidenceIds: [],
        },
        { text: "Replaced O-rings and seals on perforation head tools.", evidenceIds: [] },
      ])
    );

    const details = await ai.generateBulletsFromDescription("I did the work.", 2, opts());

    expect(details.map((d) => d.text)).toEqual([
      "Replaced O-rings and seals on perforation head tools.",
    ]);
  });

  // The limit, stated so nobody mistakes this for a general duplicate detector. Two
  // bullets about the same expired-certification catch, written genuinely differently,
  // share too few content words to trip any threshold safe enough to run unattended —
  // those are the prompt's job, not this filter's.
  it("keeps a bullet about related work that is not a restatement", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      respond([
        {
          text: "Participated in weekly hazard hunts across the base, identifying safety risks before they reached field operations.",
          evidenceIds: [],
        },
      ])
    );

    const details = await ai.generateBulletsFromDescription("I did the work.", 1, opts());
    expect(details).toHaveLength(1);
  });

  it("leaves everything alone when the entry has no bullets yet", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      respond([
        { text: ON_CV[0], evidenceIds: [] },
        { text: ON_CV[1], evidenceIds: [] },
      ])
    );

    const details = await ai.generateBulletsFromDescription(
      "I did the work.",
      2,
      opts({
        existingBullets: [],
      })
    );
    expect(details).toHaveLength(2);
  });

  // The drop happens BEFORE the shortfall check, so the count the user paid for is topped
  // back up with a different facet instead of silently coming back short.
  it("backfills the gap a dropped duplicate leaves", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(
        respond([
          {
            text: "Handed off serviced equipment to specialists for FIT checks, ensuring tools were verified ready before the next job.",
            evidenceIds: ["ev_1"],
          },
          { text: "Replaced O-rings on perforation head tools.", evidenceIds: ["ev_1"] },
        ])
      )
      .mockResolvedValueOnce(
        respond([{ text: "Monitored WinchSafe during logging.", evidenceIds: ["ev_1"] }])
      );

    const details = await ai.generateBulletsFromDescription(
      "I did the work.",
      2,
      opts({
        evidenceLedger: { evidence: [{ id: "ev_1", claim: "c", sourceQuote: "q" }] },
      })
    );

    expect(mockOpenAICreate).toHaveBeenCalledTimes(2);
    expect(details.map((d) => d.text)).toEqual([
      "Replaced O-rings on perforation head tools.",
      "Monitored WinchSafe during logging.",
    ]);
    // The retry is told BOTH things to avoid, under their own headings — what is on the
    // CV, and what this pass has already accepted.
    const retry = userMsg(1);
    expect(retry).toContain("ALREADY ON THIS ROLE");
    expect(retry).toContain("ALREADY WRITTEN");
    expect(retry).toContain("Replaced O-rings on perforation head tools.");
  });
});
