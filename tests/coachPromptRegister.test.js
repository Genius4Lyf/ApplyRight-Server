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
    // Added with the "ask, never offer" rule: its first draft illustrated the bad question
    // with one trade's words ("checking permits … coordinating the crew"), which would have
    // put that register in front of every user of every other trade.
    "permit",
    "crew",
    "site visit",
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

  it("never lets it settle an industry from an ambiguous company name in silence", async () => {
    // "Baker" was the company in the reported bug — a strong pull toward Baker Hughes,
    // oilfield services, for a user doing accounts at a bakery-sized employer. The prompt
    // used to assert outright that the model knew what the company "typically involves".
    //
    // The protection USED to be a flat ban on guessing, which was safe and also useless: a
    // well-known employer told her nothing. It is now the opposite and stronger — she may say
    // what she believes, but only OUT LOUD, as a question, before it shapes anything. A wrong
    // guess is then corrected in one turn instead of steering the whole interview unseen.
    await turn();
    const system = systemPrompt();
    expect(system).toMatch(/never carry an unspoken assumption about the industry/i);
    expect(system).toMatch(/genuinely willing to be wrong about/);
    expect(system).toMatch(/WAIT for their answer before building on it/);
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

describe("she interviews, she does not feed them answers", () => {
  // The same two failures seen on a real call, fixed in both interviewers because the user
  // can move between typing and talking mid-role and must not meet two different coaches.
  //
  // She asked "what were you doing around site visit management — like checking permits,
  // confirming access, planning the job, or coordinating the crew?" — which is the CV written
  // for them and offered for agreement. And she built that question on a sentence she had just
  // admitted she did not understand.

  it("forbids a menu of candidate activities inside the question", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/ASK, NEVER OFFER/);
    expect(systemPrompt()).toMatch(/must not contain its own answer/);
  });

  it("keeps the sanctioned scaffolds, which are a different thing", async () => {
    // suggestions/exampleAnswers are labelled, visibly examples, and cannot be mistaken for
    // something she believes they did. Banning those would have cost a real feature.
    await turn();
    expect(systemPrompt()).toMatch(/`suggestions` and `exampleAnswers` are for/);
    expect(systemPrompt()).toMatch(/suggestionsLabel/);
  });

  it("tells her to say when she did not understand, rather than tidying it into an activity", async () => {
    await turn();
    const system = systemPrompt();
    expect(system).toMatch(/IF YOU DID NOT UNDERSTAND THEM, SAY SO/);
    expect(system).toMatch(/NEVER build on a phrase you did not understand/);
    expect(system).toMatch(/puts work they never did/);
  });

  it("names speech-to-text, because a call transcript lands in this same interview", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/speech-to-text/);
  });

  it("stops her volunteering help nobody asked for", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/DO NOT VOLUNTEER/);
    expect(systemPrompt()).toMatch(/ask what they want help with/);
  });

  it("keeps the plausibility check it sits next to", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/PLAUSIBILITY CHECK/);
  });
});

describe("she says what she thinks the employer is, and lets the user correct it", () => {
  it("puts her understanding as a question, rather than assuming in silence", async () => {
    await turn();
    const system = systemPrompt();
    expect(system).toMatch(/SETTLE WHAT KIND OF PLACE THIS WAS/);
    expect(system).toMatch(/genuinely willing to be wrong about/);
    expect(system).toContain(`"Baker — that's <what you believe they do>, isn't it?"`);
  });

  it("lets her say she has not heard of them", async () => {
    await turn();
    expect(systemPrompt()).toContain('"I don\'t know Baker — what do they do?"');
  });

  it("waits for the answer and treats it as final", async () => {
    await turn();
    expect(systemPrompt()).toMatch(/WAIT for their answer before building on it/);
    expect(systemPrompt()).toMatch(/never raise it again/);
  });

  it("offers no empty question when there is no employer named", async () => {
    await turn({ entryCompany: "" });
    expect(systemPrompt()).not.toMatch(/isn't it\?/);
    // The rule itself survives — the title can still fail to tell her.
    expect(systemPrompt()).toMatch(/SETTLE WHAT KIND OF PLACE THIS WAS/);
  });
});

// THE SAMPLE ANSWERS BELONG TO THE USER'S TRADE TOO.
//
// Reported twice from a Haulage Maintenance Officer interview. Asked "did you perform
// those facility operations?", with starters already in his own words ("I carried out
// plant start-up and shut-down ___"), the panel underneath offered:
//
//   "I completed the lab's equipment warm-up sequence each morning and logged safety
//    checks so experiments could start safely."
//   "I coordinated classroom setup with AV and seating before lectures so sessions began
//    on time and students could focus."
//
// A lab and a classroom, for an oil-and-gas facility question.
//
// That was the prompt working as written — samples were required to come from UNRELATED
// fields so the model copied structure and never subject matter, which is a real
// anti-fabrication device: an in-trade sample is one a user might simply adopt.
//
// It was the wrong trade to make, for a reason the same prompt already concedes: the
// STARTERS are in the user's own trade and always have been. "Never their subject matter"
// was therefore not a principle the product held, only an inconsistency — and the cost was
// that the sample stopped teaching. Someone must translate a classroom into a haulage park
// before the shape helps them, and most will not.
//
// What replaces it as the guard is not the field but the SITUATION: a sample must describe
// a task the user has not just described, so it shows the shape without handing them their
// own answer back. The interface carries the rest — the panel is labelled "a full answer
// sounds like", each line is prefixed "e.g." and italicised, and it closes with "A sample,
// not your words — say what actually happened."
describe("the sample answers speak the user's trade", () => {
  it("requires them to come from the user's own line of work", async () => {
    await turn();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/THEY BELONG TO THE USER'S OWN LINE OF WORK/);
    expect(prompt).toMatch(/Take the vocabulary from the job title/);
    // The old rule must be gone, not merely contradicted further down.
    expect(prompt).not.toMatch(/Deliberately from unrelated fields/);
  });

  // The guard that took over from "different field". Without it, an in-trade sample is a
  // ready-made answer sitting next to an empty box.
  it("requires a DIFFERENT situation from the one just described", async () => {
    await turn();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/A DIFFERENT SITUATION FROM THE ONE THEY JUST DESCRIBED/);
    expect(prompt).toMatch(/cannot be adopted wholesale/);
    expect(prompt).toMatch(/never build it from a detail they did not give/);
  });

  // The lesson this whole file exists for: a concrete sample sentence in the prompt sets
  // the register for every trade in the catalogue. The shape is now described as a
  // skeleton rather than spelled out in one industry's words.
  it("illustrates the SHAPE without naming a trade to copy", async () => {
    await turn();
    const prompt = systemPrompt();

    expect(prompt).toMatch(/<a real, ordinary action>/);
    expect(prompt).not.toMatch(/reconciled the monthly ledger/);
  });
});
