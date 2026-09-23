// WHAT A JD-CONFIRMATION TURN IS ALLOWED TO LOOK LIKE.
//
// Reported from a live interview, all three in ONE reply:
//
//   "The job description lists **Executing routine and minor non-routine production
//    operations and first-line maintenance** — did you perform or encounter that type of
//    maintenance work in this internship? No is completely fine.
//
//    That sounds like you coordinated parts procurement so mechanics could finish repairs
//    and return trucks to service.
//
//    When you worked with procurement, what specific tasks did you handle (raising
//    requisitions, tracking deliveries, prioritising requests, or escalating delays), and
//    who did this directly help?"
//
//   1. TWO questions in one turn. The user answers one, and it is never the one you needed.
//   2. THE ORDER INVERTED — the job description first, their actual answer acknowledged
//      afterwards, which reads as having waited for them to stop talking.
//   3. A CANDIDATE LIST INSIDE THE QUESTION. The prompt already banned "was it this, this,
//      or this?"; the bracketed form is the same leading question with quieter
//      punctuation, and it walked straight through. The same three options then appeared
//      again underneath as scaffolds, which is where they were supposed to live.
//
// None of it was a hallucination. (1) and (2) came from the block's own opening words —
// "Before asking another normal impact/detail question" was written to mean INSTEAD OF and
// reads as "first, then the other one". These pin the rewrite.
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
  evidence: [],
  requirementChecks: [],
};

const REQUIREMENT = {
  id: "req_firstline",
  name: "Executing routine and minor non-routine production operations",
  type: "responsibility",
  importance: "must_have",
  aliases: [],
  proofSignals: [],
};

const turn = (over = {}) =>
  ai.coachChatTurn({
    messages: [{ who: "user", text: "I chased the spare parts with procurement" }],
    currentStepId: "history",
    focus: { section: "experience", sortId: "s1" },
    section: "experience",
    entryTitle: "Haulage Maintenance Officer",
    entryCompany: "Matrix",
    openMustHaves: [REQUIREMENT],
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

describe("the forced JD-confirmation turn", () => {
  const probeTurn = () => turn({ requiredProbe: REQUIREMENT });

  it("says the JD question REPLACES the normal follow-up, not joins it", async () => {
    await probeTurn();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/ONLY question/i);
    expect(prompt).toMatch(/REPLACES your normal follow-up/i);
    // The phrasing that caused it. "Before asking another normal impact/detail question"
    // was meant as "instead of" and read as "first, then that one as well".
    expect(prompt).not.toMatch(/Before asking another normal impact\/detail question/i);
  });

  it("caps the whole reply at one question mark", async () => {
    await probeTurn();
    expect(systemPrompt()).toMatch(/ONE QUESTION MARK IN THE WHOLE REPLY/i);
  });

  it("puts their answer first and the job description second", async () => {
    await probeTurn();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/react to what they JUST said first/i);
    // And says WHY, so it is not read as a stylistic preference and dropped.
    expect(prompt).toMatch(/waiting for them to stop talking/i);
  });

  it("bans a bracketed candidate list, not just the obvious one", async () => {
    await probeTurn();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/NO CANDIDATE LIST INSIDE THE QUESTION/i);
    expect(prompt).toMatch(/parenthetical/i);
    // Points at where examples ARE allowed, so the rule removes a habit instead of a tool.
    expect(prompt).toMatch(/scaffolds/i);
  });

  it("keeps the no-is-completely-fine exit it always had", async () => {
    await probeTurn();
    expect(systemPrompt()).toMatch(/no is completely fine/i);
  });
});

describe("the general rule behind it, which applies on every focused turn", () => {
  it("names the bracketed form as the same offence", async () => {
    await turn();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/BRACKETED list is the same offence/i);
    expect(prompt).toMatch(/was it this, this, or this/i);
  });

  it("says a requirement question replaces the usual follow-up", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/replaces your usual follow-up rather than joining it/i);
  });

  // The ban-list from coachPromptRegister.test.js: every word put in front of the model
  // sets the register for whatever trade the user is actually in. The example that
  // illustrates the bracketed-list rule is deliberately office vocabulary, and must not
  // drift into one industry's words.
  it.each(["wells", "rigged up", "offshore", "downtime", "crew", "permit"])(
    "still puts no %s in front of the model",
    async (term) => {
      await turn({ requiredProbe: REQUIREMENT });
      expect(systemPrompt().toLowerCase()).not.toContain(term.toLowerCase());
    }
  );
});

// THE DEPTH SETTING HAS TO REACH THE PROMPT, not just the cap.
//
// A cap alone gags her mid-flow at turn six: she conducts a ten-turn interview and gets
// cut off four questions early, which is worse than either setting. The prompt is what
// makes her AIM to be done by then — so a quick interview reads as finished rather than
// interrupted.
describe("how long they asked for", () => {
  it("tells her plainly when they chose quick", async () => {
    await turn({ depth: "quick" });
    const prompt = systemPrompt();

    expect(prompt).toMatch(/they chose a QUICK interview/i);
    expect(prompt).toMatch(/three to five/i);
    expect(prompt).toMatch(/Do not pad it/i);
    // The reassurance that makes stopping early acceptable rather than a loss — without
    // it, "stop sooner" reads as "get less out of them".
    expect(prompt).toMatch(/another round on the same role/i);
  });

  it("tells her the opposite when they chose thorough", async () => {
    await turn({ depth: "thorough" });
    const prompt = systemPrompt();

    expect(prompt).toMatch(/they chose a THOROUGH interview/i);
    expect(prompt).toMatch(/brief people need more questions, not fewer/i);
    expect(prompt).not.toMatch(/they chose a QUICK interview/i);
  });

  it("is thorough when nothing was chosen", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/they chose a THOROUGH interview/i);
  });

  // The requirement-chasing rule is what made a thorough interview long in the first
  // place, so on quick it has to be softened in the same breath — otherwise the two
  // instructions contradict each other and she follows whichever she read last.
  it("softens the requirement chase on a quick interview", async () => {
    await turn({ depth: "quick", requiredProbe: REQUIREMENT });
    expect(systemPrompt()).toMatch(/let the rest go/i);
  });

  it("leaves the requirement chase alone on a thorough one", async () => {
    await turn({ depth: "thorough", requiredProbe: REQUIREMENT });
    expect(systemPrompt()).not.toMatch(/let the rest go/i);
  });
});

// WHAT THIS JOB ASKS FOR, DURING A PROJECT INTERVIEW.
//
// Asked whether the requirement checklist belongs on a project at all. It does, and the
// reason is not a preference — projects ALREADY count toward the ticks. Coverage is
// computed over experience AND projects on both sides (openMustHavesFromDraft on the
// server, useJobCoverage in the client), so hiding the list during a project interview
// would leave a checklist that counts someone's projects while refusing to let them steer
// one. A requirement could go green BECAUSE of a project the user was never allowed to
// discuss against it.
//
// And for the people it matters most to, a project is the only place: a student or a
// career changer often has no role that can prove the requirement at all. The grad stage
// fork exists for exactly that.
//
// What WAS wrong was the wording. The guard read "if an area is clearly outside their
// ROLE, skip it silently" — and "role" is a word the project funnel uses for something
// else entirely ("your specific role in it"), so on a project turn the instruction could
// be read as "skip anything outside what you personally did", which is a different rule.
// Same class of ambiguity as "Before asking another normal question", which produced the
// two-question turn.
describe("a project interview and the job's requirements", () => {
  const project = (over = {}) =>
    turn({ section: "project", entryTitle: "Final-year build", entryType: "course", ...over });

  it("still raises the list — a project is real evidence", async () => {
    await project();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/TARGETING THIS ROLE/);
    expect(prompt).toMatch(/A PROJECT IS REAL EVIDENCE/);
    expect(prompt).toMatch(/ONLY place one of these can be shown/);
  });

  it("tells her most of a job's list will not apply to one", async () => {
    await project();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/small and self-contained/);
    expect(prompt).toMatch(/let the rest go without comment/);
  });

  // The ambiguity. "their role" means something else inside a project interview.
  it("does not say 'outside their role' on a project turn", async () => {
    await project();
    const prompt = systemPrompt();

    expect(prompt).not.toMatch(/clearly outside their role/);
    expect(prompt).toMatch(/outside what a project of this kind involves/);
  });

  it("still says 'their role' on a job", async () => {
    await turn({ section: "experience" });
    const prompt = systemPrompt();

    expect(prompt).toMatch(/clearly outside their role/);
    expect(prompt).not.toMatch(/A PROJECT IS REAL EVIDENCE/);
  });
});
