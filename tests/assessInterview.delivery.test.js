// The debrief is the only thing that will tell a user they froze once Phase 3
// strips coaching out of the room. These tests assert against the PROMPT TEXT
// itself, not against one sampled generation — a model that behaves on the run
// you happened to eyeball is not evidence of anything.

// Must be set before ai.service is required: the provider is chosen at import.
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";

// Capture what actually gets sent to the model.
const sent = [];
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn(async (args) => {
          sent.push(args);
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    overallScore: 60,
                    readiness: "almost",
                    summary: "ok",
                    dimensions: [],
                    strengths: [],
                    gaps: [],
                    nextSteps: [],
                    cvFindings: [
                      { claim: "Led a team of five", cvSays: "not mentioned", action: "Add it" },
                      { claim: "", cvSays: "x", action: "" },
                    ],
                    rewrites: [
                      { question: "Q", whatTheySaid: "erm", strongerVersion: "S", why: "W" },
                      { question: "Q2", whatTheySaid: "y", strongerVersion: "", why: "w" },
                    ],
                  }),
                },
              },
            ],
            usage: {},
          };
        }),
      },
    },
  }))
);
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn(() => Promise.resolve()) }));

const aiService = require("../src/services/ai.service");

const transcript = [
  { role: "interviewer", text: "Tell me about a time you led a project." },
  {
    role: "candidate",
    text: "Um, so I led a team of five on the payments migration and we cut failures a lot, you know, it was a big thing for us and I basically drove the whole rollout end to end.",
  },
];
const profile = { experience: [{ role: "Analyst", company: "Paystack" }] };

const systemOf = (call) => call.messages.find((m) => m.role === "system").content;
const userOf = (call) => call.messages.find((m) => m.role === "user").content;

const telemetry = [
  { timeToFirstWordMs: 9000, answerDurationMs: 12000, longestPauseMs: 6000, wordCount: 30 },
  { timeToFirstWordMs: 7000, answerDurationMs: 22000, longestPauseMs: 4000, wordCount: 55 },
];

describe("assessInterview — delivery guardrails", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("NEVER permits accent commentary — with telemetry", async () => {
    await aiService.assessInterview(transcript, profile, {}, {}, telemetry);
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/NEVER comment on their ACCENT/i);
    expect(sys).toMatch(/no exception/i);
  });

  it("NEVER permits accent, microphone or audio-quality commentary — without telemetry", async () => {
    await aiService.assessInterview(transcript, profile, {}, {}, null);
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/NEVER comment on their ACCENT/i);
    expect(sys).toMatch(/audio quality, microphone/i);
  });

  it("with NO telemetry, forbids delivery commentary outright", async () => {
    await aiService.assessInterview(transcript, profile, {}, {}, null);
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/NO delivery measurements were captured/i);
    expect(sys).toMatch(/say NOTHING about hesitation, pace/i);
    // And no numbers are smuggled in via the user message.
    expect(userOf(sent[0])).not.toMatch(/MEASURED DELIVERY/);
  });

  it("with telemetry, allows delivery feedback but ties it to measured figures", async () => {
    await aiService.assessInterview(transcript, profile, {}, {}, telemetry);
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/ONLY where one of those measured numbers supports it/i);
    expect(sys).toMatch(/CITE THE ACTUAL FIGURE/i);
    expect(sys).not.toMatch(/NO delivery measurements were captured/i);
    // The real numbers reach the model.
    const user = userOf(sent[0]);
    expect(user).toMatch(/MEASURED DELIVERY/);
    expect(user).toMatch(/pause before answering/);
    expect(user).toMatch(/9s/); // worst hesitation
  });

  it("computes filler density server-side from the transcript", async () => {
    const chatty = [
      transcript[0],
      { role: "candidate", text: `um like ${"word ".repeat(60)} you know um` },
    ];
    await aiService.assessInterview(chatty, profile, {}, {}, telemetry);
    expect(userOf(sent[0])).toMatch(/filler words: \d+ in \d+ words/);
  });

  it("degrades to transcript-only when telemetry is garbage rather than inventing numbers", async () => {
    await aiService.assessInterview(transcript, profile, {}, {}, [null, "nope", {}]);
    expect(systemOf(sent[0])).toMatch(/NO delivery measurements were captured/i);
  });
});

describe("assessInterview — cvFindings and rewrites", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("asks for unsupported claims under cvFindings, not buried in gaps", async () => {
    await aiService.assessInterview(transcript, profile, {}, {}, telemetry);
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/CV FINDINGS \("cvFindings"\)/);
    expect(sys).toMatch(/goes HERE, not in "gaps"/i);
    expect(sys).toMatch(/never as an accusation/i);
  });

  it("states the anti-fabrication rule for rewrites explicitly", async () => {
    await aiService.assessInterview(transcript, profile, {}, {}, telemetry);
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/ONLY be built from material the candidate actually gave you/i);
    expect(sys).toMatch(/NEVER invent an achievement, a metric, a number/i);
    expect(sys).toMatch(/too thin to rewrite honestly/i);
    expect(sys).toMatch(/max 3/);
  });

  it("returns both fields, dropping half-formed entries and capping rewrites", async () => {
    const out = await aiService.assessInterview(transcript, profile, {}, {}, telemetry);
    expect(out.cvFindings).toEqual([
      { claim: "Led a team of five", cvSays: "not mentioned", action: "Add it" },
    ]);
    expect(out.rewrites).toEqual([
      { question: "Q", whatTheySaid: "erm", strongerVersion: "S", why: "W" },
    ]);
    expect(out.rewrites.length).toBeLessThanOrEqual(3);
  });

  it("echoes the measured numbers so the UI can show what feedback was based on", async () => {
    const out = await aiService.assessInterview(transcript, profile, {}, {}, telemetry);
    expect(out.delivery.answerCount).toBe(2);
    expect(out.delivery.worstTimeToFirstWordMs).toBe(9000);
    const bare = await aiService.assessInterview(transcript, profile, {}, {}, null);
    expect(bare.delivery).toBeNull();
  });

  it("returns empty new fields on the too-short guard rather than undefined", async () => {
    const out = await aiService.assessInterview(
      [{ role: "candidate", text: "hi" }],
      profile,
      {},
      {},
      telemetry
    );
    expect(out.cvFindings).toEqual([]);
    expect(out.rewrites).toEqual([]);
  });
});

describe("archetype-aware grading (Phase 5)", () => {
  const arch = require("../src/services/interviewArchetypes.service");

  // A deliberately THIN, no-employment transcript — the exact case where a
  // scorecard undoes the room's stage-awareness at the last step.
  const gradTranscript = [
    { role: "interviewer", text: "Tell me about a time you worked with other people." },
    {
      role: "candidate",
      text: "In my final year project we were a group of four building a results portal. I did the database and I also ended up chasing everyone for their parts because we kept missing our own deadlines. We finished it and got a good grade.",
    },
  ];
  const gradProfile = { education: [{ degree: "BSc", school: "UNILAG" }], experience: [] };

  beforeEach(() => {
    sent.length = 0;
  });

  it("tells the assessor that no employment history is not a weakness or a gap", async () => {
    await aiService.assessInterview(
      gradTranscript,
      gradProfile,
      {},
      {},
      null,
      arch.getArchetype("behavioural", "grad")
    );
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/no employment history is NOT a weakness/i);
    expect(sys).toMatch(/must NOT be mentioned as one, in any dimension/i);
    expect(sys).toMatch(/never on where it came from/i);
  });

  it("excludes the archetype's does-not-grade-on list from scoring", async () => {
    await aiService.assessInterview(
      gradTranscript,
      gradProfile,
      {},
      {},
      null,
      arch.getArchetype("behavioural", "grad")
    );
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/DO NOT COUNT ANY OF THESE AGAINST THEM/);
    expect(sys).toMatch(/group project beats a vague internship/i);
    expect(sys).toMatch(/must not lower any score or appear as a gap/i);
  });

  it("tells it what the round WAS weighing", async () => {
    await aiService.assessInterview(
      gradTranscript,
      gradProfile,
      {},
      {},
      null,
      arch.getArchetype("screening", "grad")
    );
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/THIS WAS A SCREENING INTERVIEW/i);
    expect(sys).toMatch(/motivation that is specific/i);
    expect(sys).toMatch(/seniority/i); // in the exclusions
  });

  it("does not apply the graduate clause to an experienced candidate", async () => {
    await aiService.assessInterview(
      gradTranscript,
      gradProfile,
      {},
      {},
      null,
      arch.getArchetype("behavioural", "experienced")
    );
    expect(systemOf(sent[0])).not.toMatch(/no employment history/i);
  });

  it("grades exactly as before when there is no archetype", async () => {
    await aiService.assessInterview(gradTranscript, gradProfile, {}, {}, null, null);
    const sys = systemOf(sent[0]);
    expect(sys).not.toMatch(/THIS WAS A/);
    expect(sys).not.toMatch(/DO NOT COUNT ANY OF THESE/);
    // The existing rubric is untouched either way.
    expect(sys).toMatch(/Score each dimension 0-100/);
  });

  it("does not restructure the dimensions — it only constrains how they apply", async () => {
    await aiService.assessInterview(
      gradTranscript,
      gradProfile,
      {},
      {},
      null,
      arch.getArchetype("behavioural", "grad")
    );
    const sys = systemOf(sent[0]);
    ["relevance", "evidence", "structure", "communication", "depth", "motivation", "consistency"].forEach(
      (k) => expect(sys).toContain(`"${k}"`)
    );
  });
});

describe("typed sessions produce no delivery commentary (Phase 5b)", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  // A typed answer has no hesitation, no pauses and no audible filler. The
  // client sends no telemetry for these sessions, so the assessor must take the
  // transcript-only path with the delivery ban fully in force.
  it("takes the no-telemetry path when the typed engine grades a session", async () => {
    await aiService.assessInterview(transcript, profile, {}, {}, undefined);
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/NO delivery measurements were captured/i);
    expect(sys).toMatch(/say NOTHING about hesitation, pace/i);
    expect(userOf(sent[0])).not.toMatch(/MEASURED DELIVERY/);
  });

  it("computes no filler density from typed text", async () => {
    // Filler is deliberately gated behind telemetry: without it we cannot tell a
    // spoken session from a TYPED one, and counting "um" in typed text is noise.
    const wordy = [transcript[0], { role: "candidate", text: `um like ${"word ".repeat(60)}` }];
    await aiService.assessInterview(wordy, profile, {}, {}, undefined);
    expect(userOf(sent[0])).not.toMatch(/filler words/);
  });

  it("returns null delivery so the UI shows no delivery strip", async () => {
    const out = await aiService.assessInterview(transcript, profile, {}, {}, undefined);
    expect(out.delivery).toBeNull();
  });

  it("still applies the archetype exclusions to a typed session", async () => {
    const arch2 = require("../src/services/interviewArchetypes.service");
    await aiService.assessInterview(
      transcript,
      profile,
      {},
      {},
      undefined,
      arch2.getArchetype("behavioural", "grad")
    );
    const sys = systemOf(sent[0]);
    expect(sys).toMatch(/DO NOT COUNT ANY OF THESE AGAINST THEM/);
    expect(sys).toMatch(/no employment history is NOT a weakness/i);
  });
});
