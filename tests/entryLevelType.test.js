// A non-'job' EXPERIENCE entry type is coached gently even inside an 'experienced'
// session: an internship is not a place to pressure someone for business metrics. The AI
// client is mocked, so the model's OUTPUT is meaningless here — the thing under test is
// the SYSTEM PROMPT the turn builds, which is what actually steers the interview.
// Asserting on the built string is therefore the faithful unit, exactly as
// openMustHavesPrompt.test.js does.
describe("coachChatTurn — entry-level entry types are coached gently", () => {
  let aiService;
  const created = jest.fn();

  // The two stage forks, identified by wording unique to each, plus the hard guardrail
  // that must ride along with the gentle one.
  const GENTLE = /Do NOT demand a metric/;
  const GENTLE_SCAFFOLD = /project \/ coursework \/ leadership/;
  const EXPERIENCED = /XYZ\/achievement framing/;
  const EXPERIENCED_SCAFFOLD = /metric starter/;
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
                      reply: "What were you trusted with there?",
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
        { who: "aria", text: "Tell me about this one." },
        { who: "user", text: "I shadowed the ops team and ran the daily handover sheet." },
      ],
      focus: true,
      section: "experience",
      entryTitle: "Operations Intern",
      entryCompany: "Northgate Logistics",
      stage: "experienced",
      ...over,
    });

  it("gives an internship the entry-level coaching even in an 'experienced' session", async () => {
    // The whole point: the SESSION says experienced, but THIS entry is an internship, so
    // the gentle fork wins. Pressing a student for revenue figures on an internship is
    // how the coach starts inviting invention.
    await turn({ entryType: "internship" });
    const system = systemPrompt();

    expect(system).toMatch(GENTLE);
    expect(system).toMatch(GENTLE_SCAFFOLD);
    // And the experienced framing must be GONE, not merely accompanied — two contradictory
    // scaffold instructions in one prompt is how the metric starters came back anyway.
    expect(system).not.toMatch(EXPERIENCED);
    expect(system).not.toMatch(EXPERIENCED_SCAFFOLD);
  });

  it("carries the hard entry-level guardrail too, not just the softer wording", async () => {
    // The gentle block is guidance; this block is the non-negotiable version of it. The
    // broadened flag has to reach BOTH or the model keeps its metric-shaped blanks.
    await turn({ entryType: "internship" });
    const system = systemPrompt();

    expect(system).toContain(GRAD_CHECK);
    expect(system).toMatch(/never steer them toward revenue/i);
  });

  it.each(["partTime", "volunteer", "coursework", "INTERNSHIP"])(
    "treats '%s' as entry-level as well (case-insensitively)",
    async (entryType) => {
      await turn({ entryType });
      expect(systemPrompt()).toMatch(GENTLE);
    }
  );

  it("REGRESSION: a real job in an 'experienced' session still gets the experienced block", async () => {
    // The narrowing this change must not cause. A mid-career professional's actual job is
    // exactly where the XYZ/metric framing belongs.
    await turn({ entryType: "job" });
    const system = systemPrompt();

    expect(system).toMatch(EXPERIENCED);
    expect(system).toMatch(EXPERIENCED_SCAFFOLD);
    expect(system).not.toMatch(GENTLE);
    expect(system).not.toContain(GRAD_CHECK);
  });

  it("leaves a stated stage of 'grad' alone when the entry IS a job", async () => {
    // The entry type only ever RELAXES; it never overrides a gentler session stage.
    await turn({ stage: "grad", entryType: "job" });
    const system = systemPrompt();

    expect(system).toMatch(GENTLE);
    expect(system).toContain(GRAD_CHECK);
  });

  it("GUARD: a project is unaffected — its entryType vocabulary is a different one", async () => {
    // 'course' | 'personal' | 'work' are project types, not experience types, so the
    // experience stage forks must not fire for them at all: a project is framed by the
    // project branch instead, and neither stage block belongs in that prompt.
    await turn({ section: "project", entryType: "course", entryCompany: "" });
    const system = systemPrompt();

    expect(system).toMatch(/THIS IS A PROJECT, not a job/);
    expect(system).not.toMatch(GENTLE);
    expect(system).not.toMatch(EXPERIENCED);
    expect(system).not.toContain(GRAD_CHECK);
  });

  it("still honours the stage alone when no entryType was captured", async () => {
    // Older entries (and any turn that predates the field) must behave exactly as before.
    await turn();
    expect(systemPrompt()).toMatch(EXPERIENCED);

    await turn({ stage: "grad" });
    expect(systemPrompt()).toMatch(GENTLE);
  });
});
