// The role-targeting steering block inside coachChatTurn. The AI client is mocked, so
// the model's OUTPUT is meaningless here — the thing under test is the SYSTEM PROMPT
// the turn builds, which is what actually steers the interview. Asserting on the built
// string is therefore the faithful unit, exactly as projectEntryType.test.js does.
describe("coachChatTurn — role-targeting steering block", () => {
  let aiService;
  const created = jest.fn();

  // The steering block's headline, and the entry-level guardrail it must never trample.
  const TARGETING = "TARGETING THIS ROLE";
  const GRAD_CHECK = "NON-NEGOTIABLE ENTRY-LEVEL CHECK";

  beforeAll(() => {
    jest.resetModules();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.GEMINI_API_KEY;

    jest.doMock("openai", () =>
      jest.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: created.mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      reply: "What did you handle there?",
                      intent: "building",
                      description: "",
                    }),
                  },
                },
              ],
              usage: {},
            }),
          },
        },
      }))
    );
    // Fire-and-forget audit write to a DB this suite has no connection to. It resolves
    // so the service's .catch() chain stays quiet instead of logging on every turn.
    jest.doMock("../src/models/AICallLog", () => ({
      create: jest.fn().mockResolvedValue({}),
    }));

    aiService = require("../src/services/ai.service");
  });

  afterAll(() => {
    jest.dontMock("openai");
    jest.dontMock("../src/models/AICallLog");
    jest.resetModules();
  });

  beforeEach(() => created.mockClear());

  const systemPrompt = () =>
    created.mock.calls.at(-1)[0].messages.find((m) => m.role === "system").content;

  const turn = (over = {}) =>
    aiService.coachChatTurn({
      messages: [
        { who: "aria", text: "Tell me about this role." },
        { who: "user", text: "I ran the front desk at a dental clinic." },
      ],
      focus: true,
      section: "experience",
      entryTitle: "Front Desk Assistant",
      entryCompany: "Bright Smile Dental",
      ...over,
    });

  const openMustHaves = [
    { name: "Scheduling", importance: "must_have" },
    { name: "MS Excel", importance: "must_have" },
  ];

  it("names the still-open must-haves when there are any", async () => {
    await turn({ openMustHaves });
    const system = systemPrompt();

    expect(system).toContain(TARGETING);
    // The actual gap names reach the model — that is the whole point of the block.
    expect(system).toContain("Scheduling, MS Excel");
  });

  it("carries the anti-inflation hard rules alongside the names", async () => {
    // Without these, naming role requirements becomes pressure to claim them. This is
    // the guardrail that keeps the feature truthful, so it is asserted, not assumed.
    await turn({ openMustHaves });
    const system = systemPrompt();

    expect(system).toMatch(/never inflation/i);
    expect(system).toMatch(/never imply they SHOULD have done any of these/i);
    expect(system).toMatch(/never lead them to claim something they didn't do/i);
    expect(system).toMatch(/skip it silently/i);
    // An honest gap is allowed to stay a gap.
    expect(system).toMatch(/genuinely absent requirement is fine/i);
  });

  it("is absent when nothing is open (and when the param is omitted entirely)", async () => {
    await turn({ openMustHaves: [] });
    expect(systemPrompt()).not.toContain(TARGETING);

    // Every existing caller that predates the param must behave as before.
    await turn();
    expect(systemPrompt()).not.toContain(TARGETING);
  });

  it("is absent on an unfocused turn — steering only applies to the build interview", async () => {
    await turn({ focus: false, openMustHaves });
    expect(systemPrompt()).not.toContain(TARGETING);
  });

  it("does not introduce metric pressure (it names skill areas, never numbers)", async () => {
    // The grad-stage rules exist to remove metric pressure; this block must not smuggle
    // it back in through the side door.
    await turn({ openMustHaves });
    const block = systemPrompt().split(TARGETING)[1].split("\n")[0];

    expect(block).not.toMatch(/revenue|percentage|downtime|efficiency|metric/i);
  });

  it("keeps the entry-level guardrail intact on the grad path", async () => {
    // Both blocks must coexist: role targeting steers WHAT to explore, the grad check
    // still forbids pushing a student for figures.
    await turn({ stage: "grad", openMustHaves });
    const system = systemPrompt();

    expect(system).toContain(TARGETING);
    expect(system).toContain(GRAD_CHECK);
    expect(system).toMatch(/never steer them toward revenue/i);
  });

  it("still renders the grad guardrail when nothing is open", async () => {
    await turn({ stage: "grad", openMustHaves: [] });
    const system = systemPrompt();

    expect(system).toContain(GRAD_CHECK);
    expect(system).not.toContain(TARGETING);
  });

  it("leaves the wrap-up escape hatch in place so the interview still terminates", async () => {
    // The block discourages an early intent:'ready', so the mustFinish override is what
    // guarantees convergence. Losing it would let the interview run to the turn cap.
    await turn({ openMustHaves, mustFinish: true });
    const system = systemPrompt();

    expect(system).toContain(TARGETING);
    expect(system).toMatch(/set intent:'ready' now/i);
  });
});
