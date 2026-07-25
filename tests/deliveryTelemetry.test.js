const {
  summarizeDelivery,
  formatDeliveryForPrompt,
  fillerStats,
} = require("../src/services/deliveryTelemetry.service");

const answer = (o = {}) => ({
  timeToFirstWordMs: 1000,
  answerDurationMs: 45000,
  longestPauseMs: 500,
  wordCount: 120,
  ...o,
});

describe("summarizeDelivery", () => {
  it("returns null when there is nothing measured — the caller must not read this as 'fine'", () => {
    expect(summarizeDelivery(null, "")).toBeNull();
    expect(summarizeDelivery([], "")).toBeNull();
    expect(summarizeDelivery(undefined, "short")).toBeNull();
  });

  it("aggregates hesitation, length and pauses across answers", () => {
    const d = summarizeDelivery(
      [
        answer({ timeToFirstWordMs: 800, answerDurationMs: 30000, longestPauseMs: 400 }),
        answer({ timeToFirstWordMs: 9000, answerDurationMs: 12000, longestPauseMs: 6000 }),
        answer({ timeToFirstWordMs: 2000, answerDurationMs: 150000, longestPauseMs: 1000 }),
      ],
      ""
    );
    expect(d.answerCount).toBe(3);
    expect(d.medianTimeToFirstWordMs).toBe(2000);
    expect(d.worstTimeToFirstWordMs).toBe(9000);
    expect(d.shortestAnswerMs).toBe(12000);
    expect(d.longestAnswerMs).toBe(150000);
    expect(d.answersUnder15s).toBe(1);
    expect(d.answersOver2min).toBe(1);
    expect(d.longestPauseWithinAnswerMs).toBe(6000);
  });

  it("drops answers with no measured duration rather than counting them as zero", () => {
    const d = summarizeDelivery([answer(), answer({ answerDurationMs: NaN })], "");
    expect(d.answerCount).toBe(1);
  });

  it("survives a garbage payload without throwing", () => {
    expect(() => summarizeDelivery([null, 42, "x", {}], "")).not.toThrow();
    expect(summarizeDelivery([null, 42, "x", {}], "")).toBeNull();
  });
});

describe("fillerStats", () => {
  it("ignores too-little speech — a rate off a dozen words is noise", () => {
    expect(fillerStats("um so like yeah")).toBeNull();
  });

  it("counts fillers per 100 words with the worst offenders first", () => {
    const text = `um ${"word ".repeat(40)} um like like like you know ${"word ".repeat(40)}`;
    const f = fillerStats(text);
    expect(f.totalWords).toBeGreaterThan(80);
    expect(f.fillerCount).toBe(6);
    expect(f.topFillers[0]).toEqual({ word: "like", count: 3 });
    expect(f.fillerPer100Words).toBeGreaterThan(0);
  });

  it("matches on word boundaries, not substrings", () => {
    // "like" must not fire inside "unlikely"; "er" must not fire inside "very".
    const f = fillerStats(`${"unlikely very ".repeat(30)}`);
    expect(f.fillerCount).toBe(0);
  });
});

describe("formatDeliveryForPrompt", () => {
  it("renders nothing when there is nothing measured", () => {
    expect(formatDeliveryForPrompt(null)).toBe("");
  });

  it("renders figures in seconds so the assessor can quote them", () => {
    const out = formatDeliveryForPrompt(summarizeDelivery([answer({ answerDurationMs: 22000 })], ""));
    expect(out).toMatch(/22s/);
    expect(out).toMatch(/answer length/);
  });
});
