// The REAL Aria Live prompt builder, not a mock of it.
//
// tests/ariaLive.test.js mocks the whole service, which is right for the money path and
// wrong for everything else: `projectFunnel` was imported into the builder without ever
// being exported from ai.service, so every PROJECT call threw at mint — refunded, but
// unstartable — while experience calls worked, and the suite stayed green throughout.
// Nothing here is mocked.
const { buildAriaLiveInstructions } = require("../src/services/ariaLive.service");
const { FINISH_TOOL, buildSessionConfig } = require("../src/services/realtime.service");

const build = (opts) => buildAriaLiveInstructions(opts);

describe("Aria Live prompt — both branches actually build", () => {
  it("builds for a role", () => {
    expect(() => build({ section: "experience", entryTitle: "Sales Assistant" })).not.toThrow();
  });

  it.each(["course", "personal", "work", ""])("builds for a %s project", (entryType) => {
    // The branch that was broken.
    expect(() => build({ section: "project", entryTitle: "Campus App", entryType })).not.toThrow();
  });
});

describe("Aria Live prompt — she knows when she is done, and asks before ending", () => {
  const prompt = build({ section: "experience", entryTitle: "Sales Assistant" });

  it("tells her what 'enough' looks like", () => {
    expect(prompt).toMatch(/WHEN YOU HAVE ENOUGH/);
  });

  it("recaps, asks for anything else, and only then ends", () => {
    const recap = prompt.indexOf("Recap");
    const askMore = prompt.indexOf("anything else they want to add");
    const finish = prompt.indexOf("call the finish_interview tool");
    expect(recap).toBeGreaterThan(-1);
    expect(askMore).toBeGreaterThan(recap);
    expect(finish).toBeGreaterThan(askMore);
  });

  it("never lets her end the call on her own judgement", () => {
    expect(prompt).toMatch(/Never call finish_interview without their clear agreement/);
  });

  it("knows what to do when the clock is about to run out", () => {
    // lib/ariaLive.js sends a time check; this is the half that makes it mean something.
    expect(prompt).toMatch(/TIME IS NEARLY UP/);
    expect(prompt).toMatch(/carry on in the chat/);
  });
});

describe("Aria Live prompt — she digs for what people leave out", () => {
  it("asks a role about the work nobody lists as an achievement", () => {
    const prompt = build({ section: "experience", entryTitle: "Sales Assistant" });
    expect(prompt).toMatch(/DIG FOR WHAT THEY WON'T THINK TO SAY/);
    expect(prompt).toMatch(/TRUSTED with/);
    expect(prompt).toMatch(/trained/);
  });

  it("asks a project different questions from a job", () => {
    const prompt = build({ section: "project", entryTitle: "Campus App", entryType: "personal" });
    expect(prompt).toMatch(/went wrong/);
    // A project is not asked about opening up the shop.
    expect(prompt).not.toMatch(/opening or\s+closing up/);
  });

  it("works through activities one at a time, like the typed interviewer", () => {
    const prompt = build({ section: "experience", entryTitle: "Sales Assistant" });
    expect(prompt).toMatch(/ONE ACTIVITY AT A TIME/);
  });
});

describe("Aria Live prompt — honesty rules survive the move to voice", () => {
  it("never pushes an entry-level candidate for a business metric", () => {
    const prompt = build({ section: "experience", entryTitle: "Intern", careerStage: "grad" });
    expect(prompt).toMatch(/Do NOT ask for a number/);
  });

  it("raises job requirements as leads, never as facts", () => {
    const prompt = build({
      section: "experience",
      entryTitle: "Cashier",
      brief: { mustHaves: [{ name: "cash handling" }] },
    });
    expect(prompt).toMatch(/cash handling/);
    expect(prompt).toMatch(/INVESTIGATION LEADS, never facts/);
  });

  it("never answers its own question in the user's voice", () => {
    const prompt = build({ section: "experience", entryTitle: "Clerk" });
    expect(prompt).toMatch(/never answer your own question for them/);
  });
});

describe("finish_interview — the tool that lets the call end itself", () => {
  it("is only attached when asked for", () => {
    const withTool = buildSessionConfig("x", "m", "marin", { enableFinishTool: true });
    const without = buildSessionConfig("x", "m", "marin", {});
    expect(withTool.session.tools.map((t) => t.name)).toContain("finish_interview");
    expect(without.session.tools).toBeUndefined();
  });

  it("describes consent as a precondition, not a suggestion", () => {
    expect(FINISH_TOOL.description).toMatch(/ONLY after BOTH/);
    expect(FINISH_TOOL.description).toMatch(/clearly agreed/);
  });
});

describe("Aria Live prompt — the call remembers the conversation so far", () => {
  // A call used to start from nothing every time, so a SECOND call — after the first dropped,
  // after the minutes ran out, or after the person had already typed half the interview —
  // opened with "tell me what you actually did" and made them say all of it again. On a feature
  // billed by the minute, that charges someone to repeat themselves.
  const priorTurns = [
    { who: "aria", text: "Tell me what you did day to day." },
    { who: "user", text: "I kept the acquisition unit running through the whole operation." },
    { who: "aria", text: "Did you ever spot something wrong before anyone else?" },
  ];
  const resumed = build({ section: "experience", entryTitle: "Wireline Operator", priorTurns });
  const fresh = build({ section: "experience", entryTitle: "Wireline Operator" });

  it("carries what they actually said into the call", () => {
    expect(resumed).toContain("kept the acquisition unit running");
    expect(resumed).toMatch(/ALREADY BEEN TOLD/);
  });

  it("marks who said what, so she cannot claim their words as her own question", () => {
    expect(resumed).toMatch(/THEM: I kept the acquisition unit running/);
    expect(resumed).toMatch(/YOU: Tell me what you did day to day/);
  });

  it("forbids asking for any of it again", () => {
    expect(resumed).toMatch(/NEVER ask them to repeat/i);
    expect(resumed).toMatch(/still MISSING/);
  });

  it("opens by picking up, not by introducing herself again", () => {
    expect(resumed).toMatch(/PICKING UP, NOT STARTING/);
    expect(resumed).not.toMatch(/Nothing else in the first turn/);
  });

  it("leaves a FIRST call exactly as it was", () => {
    expect(fresh).toMatch(/HOW TO OPEN\n/);
    expect(fresh).not.toMatch(/ALREADY BEEN TOLD/);
    expect(fresh).toMatch(/Nothing else in the first turn/);
  });

  it("keeps every safety rule that governs a call", () => {
    for (const rule of [/WHEN YOU HAVE ENOUGH/, /call the finish_interview tool/, /HOW TO SPEAK/]) {
      expect(resumed).toMatch(rule);
    }
  });

  it("bounds a long history rather than letting it crowd out the instructions", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      who: i % 2 ? "user" : "aria",
      text: `turn number ${i} ` + "x".repeat(900),
    }));
    const big = build({ section: "experience", priorTurns: many });
    // Only the tail is carried, and each turn is trimmed.
    expect(big).not.toContain("turn number 0 ");
    expect(big).toContain("turn number 59 ");
    expect(big).not.toContain("x".repeat(400));
    // The rules still survive at the end of it.
    expect(big).toMatch(/call the finish_interview tool/);
  });

  it("treats an empty or junk history as no history at all", () => {
    for (const turns of [[], null, [{ who: "aria", text: "   " }, { who: "nonsense", text: "hi" }]]) {
      const p = build({ section: "experience", priorTurns: turns });
      expect(p).not.toMatch(/ALREADY BEEN TOLD/);
      expect(p).toMatch(/Nothing else in the first turn/);
    }
  });
});
