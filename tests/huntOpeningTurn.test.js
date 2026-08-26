// THE OPENING TURN OF A TAPPED REQUIREMENT — a regression this file exists to hold shut.
//
// The bug, exactly: the client stopped fabricating a user message (it used to push "Can we
// check whether I've done X anywhere?" into the user's own bubble, styled like typing). That
// was right — but it left the model's window ENDING WITH ARIA'S OWN LAST LINE. In the
// exploring posture the prompt offers an exit for "the conversation has moved on", and with
// no new user turn the model read its own previous message as exactly that: it took the exit
// and answered a general skills question nobody had asked.
//
// It looked fine in the BUILD posture, which has no such exit — so the failure was invisible
// on the happy path and only showed up on the branch that was supposed to be gentler.
//
// Two defences, both asserted here: the trigger is stated as an EVENT in the window, and the
// exit is explicitly barred on the opening turn.
process.env.OPENAI_API_KEY = "k-openai";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const mockOpenAICreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockOpenAICreate } } }))
);
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn().mockResolvedValue({}) }));

const ai = require("../src/services/ai.service");

const PROBE = {
  requirementId: "req_ai",
  name: "AI tools",
  type: "tool",
  sourceText: "Experience using AI tools for document screening.",
  contexts: [
    { sortId: "e1", kind: "experience", label: "Marketer at Acme" },
    { sortId: "p1", kind: "project", label: "Campus site" },
  ],
  mode: "open",
};

// The exact shape that broke it: Aria spoke last, the user has said nothing since.
const ARIA_SPOKE_LAST = [
  { who: "user", text: "done with that role" },
  { who: "aria", text: "Let me know if you want to add any projects, or we can move on!" },
];

const reply = () => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          reply: "Here's what they mean by AI tools…",
          intent: "building",
          description: "",
          suggestions: [],
          evidence: [],
          requirementChecks: [],
        }),
      },
    },
  ],
  usage: {},
});

const turn = (over = {}) =>
  ai.coachChatTurn({
    messages: ARIA_SPOKE_LAST,
    currentStepId: "skills",
    cvSummary: "1 role, 0 projects.",
    meta: { modelId: "gpt-4o-mini" },
    ...over,
  });

const sent = () => mockOpenAICreate.mock.calls.at(-1)[0].messages;
const systemPrompt = () => sent().find((m) => m.role === "system").content;

beforeEach(() => {
  mockOpenAICreate.mockClear();
  mockOpenAICreate.mockResolvedValue(reply());
});

describe("the tap reaches the model as an event, not as words from the user", () => {
  it("appends an event turn when Aria spoke last", async () => {
    await turn({ probe: PROBE });

    const last = sent().at(-1);
    expect(last.role).toBe("user");
    expect(last.content).toMatch(/^\[Event:/);
    expect(last.content).toContain("AI tools");
    expect(last.content).toMatch(/tapped/i);
  });

  it("frames it as an event and never as something the user said", async () => {
    await turn({ probe: PROBE });

    const last = sent().at(-1).content;
    // The sentence that used to be put in their mouth must not reappear by another route.
    expect(last).not.toMatch(/Can we check whether/i);
    expect(last).toMatch(/have not said anything yet/i);
  });

  it("does NOT append one when the user really did just speak", async () => {
    // Every later turn of the hunt is a real reply — the event line would be a lie there.
    await turn({
      probe: PROBE,
      messages: [...ARIA_SPOKE_LAST, { who: "user", text: "yeah I've used ChatGPT" }],
    });

    const last = sent().at(-1);
    expect(last.content).toBe("yeah I've used ChatGPT");
  });

  it("appends nothing on an ordinary, probe-less turn", async () => {
    await turn({ probe: null, messages: ARIA_SPOKE_LAST });

    expect(sent().at(-1).content).not.toMatch(/^\[Event:/);
  });

  it("still opens the turn when the window is completely empty", async () => {
    // Tapping a requirement as the very first thing in a session.
    await turn({ probe: PROBE, messages: [] });

    const last = sent().at(-1);
    expect(last.role).toBe("user");
    expect(last.content).toMatch(/^\[Event:/);
  });
});

describe("the exploring posture cannot take its exit on the opening turn", () => {
  it("bars the 'moved on' exit and names what it must do instead", async () => {
    await turn({ probe: PROBE });
    const system = systemPrompt();

    expect(system).toMatch(/EXIT DOES NOT APPLY TO THIS OPENING TURN/i);
    expect(system).toMatch(/never open the skills step/i);
    expect(system).toMatch(/not a signal/i);
  });

  it("still offers the exit for later in the conversation", async () => {
    // The exit is the whole point of the exploring posture — it must survive.
    await turn({ probe: PROBE });
    expect(systemPrompt()).toMatch(/runs its course.*intent:'answer'/is);
  });

  it("gives the BUILD posture no exit at all", async () => {
    await turn({ probe: { ...PROBE, mode: "build" } });
    const system = systemPrompt();

    expect(system).toMatch(/POSTURE — SETTLE IT/);
    expect(system).not.toMatch(/runs its course/i);
  });
});

describe("both postures explain before they ask", () => {
  it.each(["open", "build"])("leads with the JD's own words in %s posture", async (mode) => {
    await turn({ probe: { ...PROBE, mode } });
    const system = systemPrompt();

    expect(system).toContain(PROBE.sourceText);
    expect(system).toMatch(/BEAT ONE — ORIENT/);
    expect(system).toMatch(/DO NOT open with "have you used it"/i);
  });
});
