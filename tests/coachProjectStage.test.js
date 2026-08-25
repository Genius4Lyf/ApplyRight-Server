// The PROJECT branch of coachChatTurn was the one coaching branch with no career-stage
// fork at all: `resolvedStage` was computed only for section === 'experience'. So a
// student's coursework project — the only material many of them have — was coached with
// "quantified where possible" and none of the grad guardrails (no metric pressure, the
// fabricated-metric scrubbers) applied to it.
//
// The OpenAI SDK is mocked so the real callJSON/prompt-assembly runs unmocked; asserting
// on the captured system prompt is a faithful proxy for what the model is actually told.
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

const reply = (over = {}) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          reply: "Nice — what did you build it with?",
          intent: "building",
          description: "",
          suggestions: [],
          exampleAnswer: "",
          suggestionsLabel: "",
          evidence: [],
          requirementChecks: [],
          ...over,
        }),
      },
    },
  ],
  usage: {},
});

const systemPrompt = () =>
  mockOpenAICreate.mock.calls[0][0].messages.find((m) => m.role === "system").content;

const turn = (over = {}) =>
  ai.coachChatTurn({
    messages: [
      { who: "aria", text: "Tell me about this project." },
      { who: "user", text: "I built a bus-timetable app for my final-year project." },
    ],
    focus: { section: "project", sortId: "p-1" },
    entryTitle: "Bus timetable app",
    section: "project",
    stepLabel: "projects",
    cvSummary: "0 roles, 1 project.",
    brief: null,
    meta: { modelId: "gpt-4o-mini" },
    ...over,
  });

beforeEach(() => {
  mockOpenAICreate.mockClear();
  mockOpenAICreate.mockResolvedValue(reply());
});

describe("coachChatTurn — the project branch now forks on career stage", () => {
  it("carries the grad stage directive on a PROJECT turn", async () => {
    await turn({ stage: "grad" });
    const system = systemPrompt();

    expect(system).toMatch(/THIS IS A PROJECT, not a job/);
    expect(system).toMatch(/CANDIDATE STAGE/);
    expect(system).toMatch(/START of their career/i);
    expect(system).toMatch(/do NOT reach for a business metric/i);
  });

  it("uses the PROJECT section note, never the experience block's 'THIS IS A JOB'", async () => {
    // experienceCoachingBlock opens with "THIS IS A JOB (work experience)" and would
    // flatly contradict the project framing three lines above it.
    await turn({ stage: "grad" });
    const system = systemPrompt();

    expect(system).toMatch(/SECTION NOTE — PROJECTS/);
    expect(system).not.toMatch(/THIS IS A JOB/);
  });

  it("no longer tells a project to be 'quantified where possible'", async () => {
    await turn({ stage: "grad" });
    const system = systemPrompt();

    expect(system).not.toMatch(/quantified where possible/i);
    expect(system).toMatch(/IMPACT IS NOT A SYNONYM FOR A NUMBER/);
  });

  it("forks the other way for an experienced candidate's work project", async () => {
    await turn({ stage: "experienced" });
    const system = systemPrompt();

    expect(system).toMatch(/ESTABLISHED PROFESSIONAL/i);
    expect(system).not.toMatch(/START of their career/i);
  });

  it("adds no stage block at all when the caller resolves no stage", async () => {
    await turn({ stage: undefined });
    const system = systemPrompt();

    // Unchanged from before this fork existed — it must not silently default to a stage.
    expect(system).toMatch(/THIS IS A PROJECT, not a job/);
    expect(system).not.toMatch(/CANDIDATE STAGE/);
  });

  it("does not default a garbage stage to 'grad'", async () => {
    await turn({ stage: "wat" });
    expect(systemPrompt()).not.toMatch(/CANDIDATE STAGE/);
  });
});

describe("coachChatTurn — the grad metric scrubbers now cover project turns", () => {
  it("drops a fabricated metric from exampleAnswer on a grad PROJECT turn", async () => {
    mockOpenAICreate.mockResolvedValue(
      reply({ exampleAnswer: "Built an app, increasing ridership by 20%" })
    );

    const out = await turn({ stage: "grad" });
    expect(out.exampleAnswer).toBe("");
  });

  it("filters metric-shaped suggestion blanks on a grad PROJECT turn", async () => {
    mockOpenAICreate.mockResolvedValue(
      reply({
        suggestions: ["I built it for ___", "It improved efficiency by ___", "We cut costs by 30%"],
      })
    );

    const out = await turn({ stage: "grad" });
    expect(out.suggestions).toEqual(["I built it for ___"]);
  });

  it("leaves an experienced candidate's project metrics alone", async () => {
    mockOpenAICreate.mockResolvedValue(
      reply({ exampleAnswer: "Shipped the tool, cutting handling time by 30%" })
    );

    const out = await turn({ stage: "experienced" });
    expect(out.exampleAnswer).toMatch(/30%/);
  });
});

// The three project types are genuinely different kinds of evidence, so they get
// different questions in a different order — not one shared sequence with different
// adjectives. Course work is the case that most needed it: the work was SET rather than
// chosen, it was ASSESSED rather than used, and it is very often GROUP work.
describe("coachChatTurn — each project type gets its own interview", () => {
  it("runs the COURSE sequence: the brief, group-vs-solo, then the assessment", async () => {
    await turn({ entryType: "course" });
    const system = systemPrompt();

    expect(system).toMatch(/COURSE \/ ACADEMIC/);
    expect(system).toMatch(/THE BRIEF/);
    expect(system).toMatch(/SET, not chosen/i);
    expect(system).toMatch(/GROUP OR SOLO/);
    expect(system).toMatch(/HOW IT WAS ASSESSED/);
    // The other two sequences must not be in the prompt at all once the type is known.
    expect(system).not.toMatch(/PERSONAL \/ SIDE/);
    expect(system).not.toMatch(/WORK \/ CLIENT/);
  });

  // The specific overclaim a course project invites, and the specific one it must resist.
  it("stops a course project from being written as if it shipped", async () => {
    await turn({ entryType: "course" });
    const system = systemPrompt();

    expect(system).toMatch(/NEVER imply a course project shipped/i);
    expect(system).toMatch(/A demo, a viva and a submission are not a launch/i);
    // An assessment IS the outcome — Aria must not go looking for users instead.
    expect(system).toMatch(/do not go hunting for users or business impact/i);
    expect(system).toMatch(/do not treat "it was just marked" as a weak answer/i);
  });

  it("protects the individual contribution on group coursework", async () => {
    const system = (await turn({ entryType: "course" }), systemPrompt());
    expect(system).toMatch(/get their INDIVIDUAL contribution explicitly/i);
    expect(system).toMatch(/"we built X" quietly becomes "I built X"/i);
  });

  it("runs the PERSONAL sequence: motivation first, honest usage last", async () => {
    await turn({ entryType: "personal" });
    const system = systemPrompt();

    expect(system).toMatch(/PERSONAL \/ SIDE/);
    expect(system).toMatch(/WHY THEY BUILT IT/);
    expect(system).toMatch(/REAL USAGE, honestly scoped/i);
    expect(system).toMatch(/"nobody yet" is a fine answer/i);
    expect(system).not.toMatch(/COURSE \/ ACADEMIC/);
  });

  it("runs the WORK sequence: problem, who for, and what happened after", async () => {
    await turn({ entryType: "work" });
    const system = systemPrompt();

    expect(system).toMatch(/WORK \/ CLIENT/);
    expect(system).toMatch(/THE PROBLEM AND WHO FOR/);
    expect(system).toMatch(/WHAT HAPPENED AFTER/);
    expect(system).not.toMatch(/COURSE \/ ACADEMIC/);
  });

  // Before the type is known she has to be able to recognise which interview she's in.
  it("carries all three sequences when the type has not been picked yet", async () => {
    await turn({ entryType: "" });
    const system = systemPrompt();

    expect(system).toMatch(/COURSE \/ ACADEMIC/);
    expect(system).toMatch(/PERSONAL \/ SIDE/);
    expect(system).toMatch(/WORK \/ CLIENT/);
    expect(system).toMatch(/switch to that type's sequence as soon as they do/i);
  });

  it("never re-asks the type once it is known", async () => {
    await turn({ entryType: "course" });
    expect(systemPrompt()).toMatch(/do NOT ask the user what kind of project it is/i);
  });
});
