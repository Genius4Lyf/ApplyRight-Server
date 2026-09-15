// THE PROMPT MUST NOT PICK AN INDUSTRY FOR THE USER.
//
// Reported bug: a user building an "Accounting Intern" role was asked what her work
// "helped the team complete safely or reliably" — oilfield language in an accounting
// interview.
//
// It was not a hallucination. The prompt's own few-shot examples were dense oilfield
// ("we handled about ___ wells per shift", "rigged up the logging tool", "shift handover
// checklist", "two crews"), and the `exampleAnswers` line is literally the definition of
// what a strong answer SOUNDS like — so it set the register for every role in the
// catalogue, on every focused turn, above the section and stage forks.
//
// Nothing caught it because no test looked, and the fixtures across this suite are
// themselves overwhelmingly oilfield and nursing. This is the test that looks.
process.env.OPENAI_API_KEY = "k-openai";
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const mockOpenAICreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockOpenAICreate } } }))
);
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn().mockResolvedValue({}) }));

const ai = require("../src/services/ai.service");

const PAYLOAD = {
  reply: "What did you do there?",
  intent: "building",
  description: "",
  suggestions: [],
  exampleAnswers: [],
  suggestionsLabel: "",
  layout: "prose",
  blocks: [],
  evidence: [],
  requirementChecks: [],
};

const turn = (over = {}) =>
  ai.coachChatTurn({
    messages: [{ who: "user", text: "I arranged the invoices" }],
    currentStepId: "history",
    focus: { section: "experience", sortId: "s1" },
    // `section` is a top-level parameter, not read off `focus` — the stage forks key on it.
    section: "experience",
    entryTitle: "Accounting Intern",
    entryCompany: "Baker",
    ...over,
  });

const systemPrompt = () => mockOpenAICreate.mock.calls[0][0].messages[0].content;

beforeEach(() => {
  mockOpenAICreate.mockReset();
  mockOpenAICreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(PAYLOAD) }, finish_reason: "stop" }],
    usage: {},
  });
});

describe("no industry is baked into the prompt", () => {
  // The exact vocabulary that leaked. Each of these was in a few-shot example that rode
  // every single focused turn regardless of the role being discussed.
  const OILFIELD = [
    "wells",
    "rigged up",
    "logging tool",
    "pressure anomaly",
    "offshore",
    "crews",
    "per shift",
    "a shift",
    "handover",
    "downtime",
  ];

  it.each(OILFIELD)("does not put %s in front of the model", async (term) => {
    await turn();
    expect(systemPrompt().toLowerCase()).not.toContain(term.toLowerCase());
  });

  it("stays clean for every career stage", async () => {
    // The stage forks were not the source, but they are appended to the same prompt and a
    // future edit could reintroduce it in any one of the three.
    for (const stage of ["grad", "experienced", "changer"]) {
      mockOpenAICreate.mockClear();
      await turn({ stage });
      const system = systemPrompt().toLowerCase();
      OILFIELD.forEach((term) => expect(system).not.toContain(term.toLowerCase()));
    }
  });

  it("stays clean on a project turn too", async () => {
    await turn({ focus: { section: "project", sortId: "p1" }, section: "project" });
    const system = systemPrompt().toLowerCase();
    OILFIELD.forEach((term) => expect(system).not.toContain(term.toLowerCase()));
  });
});

describe("it tells the model whose language to speak", () => {
  it("instructs it to take vocabulary from the role, which nothing did before", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/SPEAK THEIR TRADE/);
  });

  it("names the entry's own job title, so there is a register to take", async () => {
    await turn();
    expect(systemPrompt()).toContain("Accounting Intern");
  });

  it("warns it off guessing an industry from an ambiguous company name", async () => {
    // "Baker" was the company in the reported bug — a strong pull toward Baker Hughes,
    // oilfield services, for a user doing accounts at a bakery-sized employer. The prompt
    // used to assert outright that the model knew what the company "typically involves".
    await turn();
    const system = systemPrompt();
    expect(system).toMatch(/NEVER guess a sector from it/);
    expect(system).not.toMatch(/what that role and company typically involves/);
  });

  it("says nothing about the company when there is none", async () => {
    await turn({ entryCompany: "" });
    expect(systemPrompt()).not.toMatch(/NEVER guess a sector from it/);
  });
});

describe("the entry-level guardrail", () => {
  it("no longer names an industrial metric in its own ban-list", async () => {
    // It banned "revenue, efficiency, downtime, percentages" — and "downtime" is itself
    // plant-and-equipment vocabulary, so the ban carried the register it was banning.
    await turn({ stage: "grad" });
    expect(systemPrompt().toLowerCase()).not.toContain("downtime");
    // The ban itself must survive intact.
    expect(systemPrompt()).toMatch(/never steer them toward revenue, efficiency/i);
  });
});

describe("Aria never answers her own question in the user's voice", () => {
  // Reported from production: the user replied "I used Microsoft Excel" and Aria came
  // back with "Using Microsoft Excel, I organized invoice data by categorizing purchases
  // and ensuring accuracy in records. This helped the finance team track expenses
  // effectively." — a first-person sentence, in the candidate's voice, built almost
  // entirely out of details she had never been given.
  //
  // Two harms at once. She wrote the answer for them, so the interview stops gathering
  // anything true; and because it is in their voice and reads like a recap, they believe
  // it is what they said, and it ends up on the CV as fact.
  //
  // The pull is structural: `suggestions`, `exampleAnswers`, `description` and `evidence`
  // are ALL specified as first-person, so first person is everywhere in this prompt. Only
  // `reply` is Aria talking, and nothing used to say so.
  it("says the reply is second person, and says it on a focused turn", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/YOUR REPLY IS YOUR OWN VOICE/);
    expect(systemPrompt()).toMatch(/second person/i);
  });

  it("bans a first-person sentence about their work inside the reply", async () => {
    await turn();
    expect(systemPrompt()).toMatch(
      /NEVER compose a sentence beginning "I \.\.\." about their work/
    );
  });

  it("carves out the starter bullets, which ARE first person by design", async () => {
    // Without the exception the model has two contradictory instructions: write the
    // first-person starters into the reply, and never write first person in the reply.
    await turn();
    expect(systemPrompt()).toMatch(/only first-person lines allowed in `reply`/i);
    expect(systemPrompt()).toMatch(/WRITE THE STARTERS INTO `reply`/);
  });

  it("keeps the rule on a project turn and on every career stage", async () => {
    for (const over of [
      { focus: { section: "project", sortId: "p1" }, section: "project" },
      { stage: "grad" },
      { stage: "experienced" },
      { stage: "changer" },
    ]) {
      mockOpenAICreate.mockClear();
      await turn(over);
      expect(systemPrompt()).toMatch(/YOUR REPLY IS YOUR OWN VOICE/);
    }
  });

  it("no longer asks for a bare 'warm reaction', which is what it restated", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/React in ONE short sentence of your own/);
    expect(systemPrompt()).not.toMatch(/Warmly react, then ask ONE focused follow-up/);
  });
});
