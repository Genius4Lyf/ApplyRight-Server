// Call settings: depth (thorough / quick), style (friendly / direct / coach), voice, pace.
//
// Two promises to pin. First, each setting really changes the call. Second — the one that
// matters more — NO setting weakens the result: every mode keeps one question at a time, the
// recap-and-confirm before ending, and the rules against inventing anything. "Direct" means
// fewer words from Aria, not a weaker CV.
const {
  normalizeCallSettings,
  DEFAULT_CALL_SETTINGS,
  PACE_SPEED,
} = require("../src/config/ariaCallSettings");
const { buildAriaLiveInstructions } = require("../src/services/ariaLive.service");
const { buildSessionConfig } = require("../src/services/realtime.service");
const User = require("../src/models/User");

const base = { section: "experience", entryTitle: "Cashier" };
const prompt = (settings) => buildAriaLiveInstructions({ ...base, ...settings });

describe("normalizeCallSettings — only listed values get through", () => {
  it("fills in the defaults for nothing at all", () => {
    expect(normalizeCallSettings()).toEqual(DEFAULT_CALL_SETTINGS);
    expect(normalizeCallSettings(null)).toEqual(DEFAULT_CALL_SETTINGS);
  });

  it("keeps valid choices", () => {
    const picked = { depth: "quick", style: "coach", voice: "cedar", pace: "slower" };
    expect(normalizeCallSettings(picked)).toEqual(picked);
  });

  it("replaces anything unlisted with the default, field by field", () => {
    expect(
      normalizeCallSettings({ depth: "quick", style: "shouty", voice: "alloy", pace: 3 })
    ).toEqual({ depth: "quick", style: "friendly", voice: "marin", pace: "normal" });
  });
});

describe("depth — what Aria asks", () => {
  it("thorough digs for the small things", () => {
    const p = prompt({ depth: "thorough" });
    expect(p).toMatch(/DIG FOR WHAT THEY WON'T THINK TO SAY/);
    expect(p).toMatch(/TRUSTED with/);
  });

  it("quick skips the digging and keeps it short", () => {
    const p = prompt({ depth: "quick" });
    expect(p).not.toMatch(/DIG FOR WHAT THEY WON'T THINK TO SAY/);
    expect(p).toMatch(/KEEP IT FOCUSED/);
    expect(p).toMatch(/three to six questions/);
  });

  it("quick still asks what changed because of them", () => {
    // Quick means less digging, not results-free bullets.
    expect(prompt({ depth: "quick" })).toMatch(/what changed because of them/);
  });
});

describe("style — how Aria sounds", () => {
  it("direct drops the chat and the praise", () => {
    const p = prompt({ style: "direct" });
    expect(p).toMatch(/STYLE — DIRECT/);
    expect(p).toMatch(/No small talk, no praise/);
  });

  it("coach explains why she asks, one sentence at a time", () => {
    const p = prompt({ style: "coach" });
    expect(p).toMatch(/STYLE — COACH/);
    expect(p).toMatch(/never a lecture/);
  });

  it("friendly is what nobody choosing gets", () => {
    expect(prompt({})).toBe(prompt({ style: "friendly", depth: "thorough" }));
  });
});

describe("no setting weakens the result", () => {
  const every = [];
  for (const depth of ["thorough", "quick"]) {
    for (const style of ["friendly", "direct", "coach"]) every.push({ depth, style });
  }

  it.each(every)("$depth + $style keeps one question per turn", (s) => {
    expect(prompt(s)).toMatch(/One short question at a time/);
  });

  it.each(every)("$depth + $style recaps and asks before ending", (s) => {
    const p = prompt(s);
    expect(p).toMatch(/HOW TO FINISH/);
    expect(p).toMatch(/Never call finish_interview without their clear agreement/);
  });

  it.each(every)("$depth + $style keeps the rules against inventing anything", (s) => {
    expect(prompt(s)).toMatch(/Never state a number, date, employer, client, tool or job title/);
  });

  it.each(every)("$depth + $style still raises the job's requirements", (s) => {
    const p = buildAriaLiveInstructions({
      ...base,
      ...s,
      brief: { mustHaves: [{ name: "cash handling" }] },
    });
    expect(p).toMatch(/cash handling/);
  });
});

describe("voice and pace — reach OpenAI", () => {
  it("slower pace sends a gentle speed, normal sends none", () => {
    expect(PACE_SPEED.slower).toBe(0.9);
    expect(
      buildSessionConfig("x", "m", "cedar", { speed: PACE_SPEED.slower }).session.audio.output
    ).toEqual({ voice: "cedar", speed: 0.9 });
    expect(
      buildSessionConfig("x", "m", "marin", { speed: PACE_SPEED.normal }).session.audio.output
    ).toEqual({ voice: "marin" });
  });
});

describe("the User schema stores them", () => {
  it("defaults every account to the default call", () => {
    expect(new User({}).settings.ariaCall.toObject()).toEqual(DEFAULT_CALL_SETTINGS);
  });

  it("refuses a value outside the list", () => {
    const u = new User({ settings: { ariaCall: { style: "shouty" } } });
    expect(u.validateSync()?.errors?.["settings.ariaCall.style"]).toBeDefined();
  });
});
