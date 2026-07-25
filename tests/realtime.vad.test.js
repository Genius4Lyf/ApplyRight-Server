// Turn-taking config for the live interview. The bug this guards against is a
// silent one: an interviewer that ends the candidate's turn after 600ms of quiet
// cuts people off mid-thought, and the session still mints perfectly happily.
const realtime = require("../src/services/realtime.service");

const { buildTurnDetection } = realtime;

describe("realtime turn detection", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("defaults to semantic_vad with low eagerness (wait for the candidate)", () => {
    delete process.env.REALTIME_VAD_EAGERNESS;
    expect(buildTurnDetection()).toEqual({ type: "semantic_vad", eagerness: "low" });
  });

  it("lets eagerness be tuned from env without a deploy", () => {
    process.env.REALTIME_VAD_EAGERNESS = "medium";
    expect(buildTurnDetection()).toEqual({ type: "semantic_vad", eagerness: "medium" });
  });

  it("ignores an invalid eagerness rather than sending it to the API", () => {
    process.env.REALTIME_VAD_EAGERNESS = "extremely";
    expect(buildTurnDetection()).toEqual({ type: "semantic_vad", eagerness: "low" });
  });

  it("can be forced onto the silence-based fallback, tuned well above 600ms", () => {
    process.env.REALTIME_VAD_EAGERNESS = "server_vad";
    delete process.env.REALTIME_VAD_SILENCE_MS;
    const td = buildTurnDetection();
    expect(td.type).toBe("server_vad");
    expect(td.silence_duration_ms).toBe(1800);
    // The regression this whole change exists to prevent.
    expect(td.silence_duration_ms).toBeGreaterThanOrEqual(1500);
  });

  it("honours REALTIME_VAD_SILENCE_MS on the fallback", () => {
    process.env.REALTIME_VAD_EAGERNESS = "server_vad";
    process.env.REALTIME_VAD_SILENCE_MS = "2000";
    expect(buildTurnDetection().silence_duration_ms).toBe(2000);
  });
});
