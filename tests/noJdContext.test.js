// The NO-job-description path. Before this, "no JD" was not a weaker strategy but the
// ABSENCE of one: briefContextBlock returned "" and the surrounding prompt carried on
// talking about a target job that was not there. Most users have no specific posting, so
// this is the common path, not the edge case.
//
// The OpenAI SDK is mocked so the real callJSON + prompt assembly run unmocked; asserting
// on the captured prompt is a faithful proxy for what the model is actually told.
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

const NO_JD = {
  roleFamily: "Registered Nurse",
  keywords: [
    { name: "patient assessment", importance: "must_have" },
    { name: "medication administration", importance: "nice_to_have" },
  ],
};

const BRIEF = {
  role: "Registered Nurse",
  company: "St Mary's",
  seniority: "mid",
  requirements: [{ id: "req_1", name: "Triage", type: "domain", priority: "must_have" }],
  mustHaves: [{ name: "Triage", importance: "must_have" }],
};

const promptOf = (role) =>
  mockOpenAICreate.mock.calls[0][0].messages.find((m) => m.role === role).content;

const generate = (options = {}) =>
  ai.generateBulletsFromDescription("Ran the ward handover every shift.", 2, {
    role: "Staff Nurse",
    returnDetails: true,
    meta: { modelId: "gpt-4o-mini" },
    ...options,
  });

beforeEach(() => {
  mockOpenAICreate.mockClear();
  mockOpenAICreate.mockResolvedValue(
    respond([
      { text: "Ran ward handover each shift", evidenceIds: [] },
      { text: "Coordinated care across the team", evidenceIds: [] },
    ])
  );
});

describe("generateBulletsFromDescription — the no-JD prompt says what to do", () => {
  it("states there is no target job and names the role family to write for", async () => {
    await generate({ noJd: NO_JD });
    const user = promptOf("user");

    expect(user).toMatch(/NO TARGET JOB/);
    expect(user).toMatch(/strong all-rounder/i);
    expect(user).toMatch(/ROLE FAMILY: write for a general Registered Nurse audience/);
    expect(user).toMatch(/ALL-ROUNDER RULE/);
  });

  // The inferred vocabulary is the one thing here that could be mistaken for evidence,
  // so the labelling is the load-bearing part.
  it("labels inferred keywords as trade vocabulary, never as requirements or facts", async () => {
    await generate({ noJd: NO_JD });
    const user = promptOf("user");

    expect(user).toMatch(/patient assessment, medication administration/);
    expect(user).toMatch(/inferred from the job title/i);
    expect(user).toMatch(/NOT an employer's requirements, and NOT facts about this candidate/i);
    expect(user).toMatch(/Never introduce one as if the user did it/i);
  });

  it("still frames the all-rounder when nothing could be inferred", async () => {
    await generate({ noJd: null });
    const user = promptOf("user");

    expect(user).toMatch(/NO TARGET JOB/);
    expect(user).not.toMatch(/TYPICAL FOR THIS ROLE FAMILY/);
  });
});

describe("generateBulletsFromDescription — dangling JD clauses are gone", () => {
  // These shipped to every brief-less user: instructions about a target job that was not
  // in their prompt, with no referent.
  it("drops the 'target job changes emphasis' clause when there is no JD", async () => {
    await generate({ noJd: NO_JD });

    expect(promptOf("system")).not.toMatch(/target job changes emphasis/i);
    expect(promptOf("user")).not.toMatch(/A JD requirement on its own is never support/i);
  });

  it("drops requirementIds from the JSON contract entirely when there is no JD", async () => {
    // With no brief every returned requirementId is filtered out anyway, so asking for the
    // field is noise that invites the model to invent ids.
    await generate({ noJd: NO_JD });
    expect(promptOf("user")).not.toMatch(/requirementIds/);
  });

  it("keeps every one of those when a brief IS present", async () => {
    await generate({ brief: BRIEF });

    expect(promptOf("system")).toMatch(/target job changes emphasis/i);
    const user = promptOf("user");
    expect(user).toMatch(/A JD requirement on its own is never support/i);
    expect(user).toMatch(/requirementIds/);
    expect(user).toMatch(/TARGET: Registered Nurse at St Mary's/);
    expect(user).not.toMatch(/NO TARGET JOB/);
  });
});

describe("rewriteRoleBullets — stops claiming a target job it does not have", () => {
  beforeEach(() => {
    mockOpenAICreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              bullets: [
                { before: "Helped with handover", after: "Ran ward handover", changed: true },
              ],
            }),
          },
        },
      ],
      usage: {},
    });
  });

  it("says it is sharpening for general strength, with no gap list", async () => {
    await ai.rewriteRoleBullets({
      bullets: ["Helped with handover"],
      role: "Staff Nurse",
      noJd: NO_JD,
      meta: { modelId: "gpt-4o-mini" },
    });

    expect(promptOf("system")).toMatch(/no target job to aim at/i);
    expect(promptOf("system")).not.toMatch(/against a target job/i);
    // The gap header used to render with "none provided" beneath it — an instruction to
    // aim at nothing in particular.
    expect(promptOf("user")).not.toMatch(/WHAT THIS JOB WANTS THAT THE CV IS SILENT ON/);
    expect(promptOf("user")).not.toMatch(/none provided/);
    expect(promptOf("system")).not.toMatch(/TEMPTATION/);
  });

  it("keeps the tailoring framing and the temptation warning when a brief IS present", async () => {
    await ai.rewriteRoleBullets({
      bullets: ["Helped with handover"],
      role: "Staff Nurse",
      brief: BRIEF,
      missingKeywords: ["triage"],
      meta: { modelId: "gpt-4o-mini" },
    });

    expect(promptOf("system")).toMatch(/against a target job/i);
    expect(promptOf("system")).toMatch(/TEMPTATION, not a licence/);
    expect(promptOf("user")).toMatch(/WHAT THIS JOB WANTS THAT THE CV IS SILENT ON/);
    expect(promptOf("user")).toMatch(/triage/);
  });
});

describe("coachChatTurn — the interviewer is told how to interview without a JD", () => {
  beforeEach(() => {
    mockOpenAICreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: "What did that involve?",
              intent: "building",
              description: "",
              suggestions: [],
              exampleAnswer: "",
              suggestionsLabel: "",
              evidence: [],
              requirementChecks: [],
            }),
          },
        },
      ],
      usage: {},
    });
  });

  const turn = (over = {}) =>
    ai.coachChatTurn({
      messages: [{ who: "user", text: "I ran the ward handover." }],
      focus: { section: "experience", sortId: "e-1" },
      entryTitle: "Staff Nurse",
      section: "experience",
      stepLabel: "history",
      cvSummary: "1 role.",
      brief: null,
      meta: { modelId: "gpt-4o-mini" },
      ...over,
    });

  it("replaces the bare 'TARGET: none' with real instruction", async () => {
    await turn({ noJd: NO_JD });
    const system = promptOf("system");

    expect(system).toMatch(/TARGET: none — the user is building a strong all-rounder/);
    expect(system).toMatch(/FULL breadth of what they did/i);
    expect(system).toMatch(/never imply an employer asked for something/i);
  });

  it("offers inferred vocabulary as soft leads, explicitly not requirements", async () => {
    await turn({ noJd: NO_JD });
    const system = promptOf("system");

    expect(system).toMatch(/TYPICAL FOR THIS ROLE FAMILY/);
    expect(system).toMatch(/NOT requirements, NOT facts about them/);
    expect(system).toMatch(/only where genuinely plausible/i);
  });

  it("omits the lead list when nothing was inferred", async () => {
    await turn({ noJd: null });
    const system = promptOf("system");

    expect(system).toMatch(/TARGET: none/);
    expect(system).not.toMatch(/TYPICAL FOR THIS ROLE FAMILY/);
  });
});
