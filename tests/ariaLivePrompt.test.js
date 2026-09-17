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
