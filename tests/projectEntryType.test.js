// PROJECT entryType — the type persisted on the ENTRY, not only in the transcript.
//
// An experience entry has always carried its own `entryType`. A project's type existed
// ONLY as a chat marker, so the two cases that never see this thread's markers — a
// TAILORED project (cloned from the base CV) and an "Edit with Aria" interview opened
// later — left Aria blind: she re-asked a question the user had already answered, and
// framed a project with the wording written for jobs.
//
// Two units here, one per half of the fix:
//   1. the SCHEMA actually stores it (strict mode drops undeclared paths at cast time —
//      testable with no database, since the cast is the exact moment it would be lost);
//   2. coachChatTurn FRAMES a project turn by that type, and does NOT reach for the
//      experience internship/part-time wording.

const DraftCV = require("../src/models/DraftCV");

const USER_ID = "60c72b2f9b1d8b2bad6e1a11";

describe("DraftCV.projects.entryType — survives a save (strict mode)", () => {
  const draftWith = (projects) => new DraftCV({ userId: USER_ID, title: "My CV", projects });

  it("KEEPS entryType on a project entry through the document cast", () => {
    // The regression: on the pre-fix schema this is stripped before it can reach the
    // database, so a tailored project lands with no type at all.
    const doc = draftWith([{ _sortId: "proj-1", title: "Analytical Engine", entryType: "course" }]);
    expect(doc.projects[0].entryType).toBe("course");
    expect(doc.toObject().projects[0].entryType).toBe("course");
  });

  it("stores the PROJECT vocabulary, per entry, without touching experience's", () => {
    const doc = new DraftCV({
      userId: USER_ID,
      title: "My CV",
      // Same field name on both lists, deliberately — different value vocabularies.
      experience: [{ _sortId: "exp-1", title: "Analyst", entryType: "internship" }],
      projects: [
        { _sortId: "p-a", title: "Capstone", entryType: "course" },
        { _sortId: "p-b", title: "Side app", entryType: "personal" },
        { _sortId: "p-c", title: "Client portal", entryType: "work" },
      ],
    });
    expect(doc.projects.map((p) => p.entryType)).toEqual(["course", "personal", "work"]);
    expect(doc.experience[0].entryType).toBe("internship");
  });

  it("leaves it undefined for an older project that never picked one", () => {
    // The fallback path the prompt still supports: type known only from the transcript.
    const doc = draftWith([{ _sortId: "proj-1", title: "Old project" }]);
    expect(doc.projects[0].entryType).toBeUndefined();
  });

  it("still strips a path the schema does NOT declare (strict mode is really on)", () => {
    // Guards the test itself: without this, assertion 1 could pass on a schema that
    // simply kept everything, and would prove nothing about the new field.
    const doc = draftWith([{ _sortId: "proj-1", title: "X", notARealField: "nope" }]);
    expect(doc.toObject().projects[0].notARealField).toBeUndefined();
  });
});

// ── The prompt ────────────────────────────────────────────────────────────────────────
//
// ai.service picks its provider AT REQUIRE TIME from the API keys in the environment, so
// the key is set and the SDK mocked BEFORE the module is pulled in (below). The mocked
// client is the seam: whatever coachChatTurn builds arrives as the `system` message, and
// that string is the unit under test — no network, no credits.
describe("coachChatTurn — a PROJECT turn is framed by its type", () => {
  const created = jest.fn();
  let aiService;

  // The exact clause written for EXPERIENCE entry types. It is wrong for a project (a
  // project's type is course/personal/work), which is the bug this slice fixes.
  const EXPERIENCE_FRAMING = "internships emphasise supervised learning";

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
                      reply: "What did it do?",
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
    // The audit log is a fire-and-forget write to a database this suite has no
    // connection to; stubbing it keeps the unit honest and the handle clean.
    jest.doMock("../src/models/AICallLog", () => ({ create: jest.fn() }));

    aiService = require("../src/services/ai.service");
  });

  afterAll(() => {
    jest.dontMock("openai");
    jest.dontMock("../src/models/AICallLog");
    jest.resetModules();
  });

  beforeEach(() => created.mockClear());

  // The system prompt of the last call the mocked client received.
  const systemPrompt = () =>
    created.mock.calls.at(-1)[0].messages.find((m) => m.role === "system").content;

  const turn = (over = {}) =>
    aiService.coachChatTurn({
      messages: [
        { who: "aria", text: "Tell me about it." },
        { who: "user", text: "I built a booking tool." },
      ],
      focus: true,
      section: "project",
      entryTitle: "Campus booking tool",
      ...over,
    });

  it("guides by the project type and does not re-ask it", async () => {
    await turn({ entryType: "course" });
    const system = systemPrompt();

    // The type is stated as KNOWN, with an explicit instruction not to ask for it.
    expect(system).toContain("PROJECT TYPE: course");
    expect(system).toMatch(/do NOT ask the user what kind of project it is/i);
    // The type now selects a whole SEQUENCE, not just an emphasis. The three types are
    // different kinds of evidence — coursework was set rather than chosen and assessed
    // rather than used — so they get different questions in a different order.
    expect(system).toContain("COURSE / ACADEMIC");
    expect(system).toMatch(/Run the course sequence above/i);
    // And it must NOT reach for the experience wording.
    expect(system).not.toContain(EXPERIENCE_FRAMING);
  });

  it("falls back to drawing the type out when the entry has none", async () => {
    // Older/thread-only sessions: the entry predates the field, so the conversation is
    // still where the type comes from. Losing this would strand them with no type at all.
    await turn({ entryType: "" });
    const system = systemPrompt();

    expect(system).toContain("The user states the type early in the thread");
    expect(system).not.toContain("PROJECT TYPE:");
    expect(system).not.toContain(EXPERIENCE_FRAMING);
  });

  it("still applies the EXPERIENCE framing to an experience turn", async () => {
    // The gate is on `section`, so work history must be completely unaffected.
    await turn({ section: "experience", entryType: "internship", entryCompany: "RSA" });
    const system = systemPrompt();

    expect(system).toContain("ENTRY TYPE: internship");
    expect(system).toContain(EXPERIENCE_FRAMING);
    expect(system).not.toContain("PROJECT TYPE:");
  });
});
