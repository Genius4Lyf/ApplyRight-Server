// Regression test for the panel voice/gender mismatch bug: voices were assigned
// by seat index, so an AI-named "Amara" (female) could get a male voice. Voices
// must now match each seat's gender and stay distinct across the panel.
const aiService = require("../src/services/ai.service");

// Mirrors the gender-tagged pools in ai.service.js (assignPanelVoices). All must
// be a subset of realtime.service ALLOWED_VOICES.
const FEMALE_VOICES = ["marin", "shimmer", "sage"];
const MALE_VOICES = ["cedar", "ash", "verse"];
const NEUTRAL_VOICE = "alloy";
const ALLOWED_VOICES = ["marin", "cedar", "alloy", "sage", "verse", "shimmer", "ash"];

const poolFor = (gender) =>
  gender === "female"
    ? FEMALE_VOICES
    : gender === "male"
      ? MALE_VOICES
      : [NEUTRAL_VOICE, ...MALE_VOICES, ...FEMALE_VOICES];

const assertGenderMatchedDistinct = (seats) => {
  expect(seats.length).toBeGreaterThanOrEqual(2);
  const voices = seats.map((s) => s.voice);
  // All voices are mint-able (in ALLOWED_VOICES).
  voices.forEach((v) => expect(ALLOWED_VOICES).toContain(v));
  // Each seat's voice matches its gender pool.
  seats.forEach((s) => expect(poolFor(s.gender)).toContain(s.voice));
  // Voices are distinct across the panel.
  expect(new Set(voices).size).toBe(voices.length);
};

describe("interview panel voice assignment", () => {
  it("fallback panel gets gender-matched, distinct voices", () => {
    const seats = aiService.interviewPanelTeaser("Software Engineer");
    // Renee (female), Marcus (male), Priya (female).
    expect(seats.map((s) => s.gender)).toEqual(["female", "male", "female"]);
    assertGenderMatchedDistinct(seats);
    // A female name must not land a male voice, and vice-versa.
    const renee = seats.find((s) => s.name === "Renee");
    const marcus = seats.find((s) => s.name === "Marcus");
    expect(FEMALE_VOICES).toContain(renee.voice);
    expect(MALE_VOICES).toContain(marcus.voice);
  });

  it("buildInterviewPanel degrades to a gender-matched, distinct-voiced panel", async () => {
    // Force mock mode (no keys) so the AI call is unavailable and buildInterviewPanel
    // takes its graceful fallback path — deterministic, no network — then assert the
    // returned panel still has gender-matched, distinct voices.
    const { OPENAI_API_KEY, GEMINI_API_KEY } = process.env;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    jest.resetModules();
    try {
      const freshAi = require("../src/services/ai.service");
      const seats = await freshAi.buildInterviewPanel({ jobTitle: "Nurse" }, {}, "", {});
      assertGenderMatchedDistinct(seats);
    } finally {
      if (OPENAI_API_KEY !== undefined) process.env.OPENAI_API_KEY = OPENAI_API_KEY;
      if (GEMINI_API_KEY !== undefined) process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    }
  });
});
