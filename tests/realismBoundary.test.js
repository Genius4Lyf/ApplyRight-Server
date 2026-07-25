// The realism boundary: warm in manner, neutral in content. Asserted against the
// assembled PROMPT TEXT for every mode, because a room that behaves on the one
// session you happened to listen to is not evidence that the coaching is gone.
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";

// Capture what the TYPED engine actually sends, so both engines can be guarded by
// the same assertions in the same file — the whole point being that they cannot
// drift apart without a test failing.
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
                    spoken: "…",
                    displayQuestion: "…",
                    isFollowUp: false,
                    nextSpineIndex: 1,
                    done: false,
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

const ai = require("../src/services/ai.service");

const ctx = { summary: "S", experience: [{ role: "Analyst", company: "Paystack" }] };
const panel = [
  { name: "Ada", role: "HR", focus: "fit" },
  { name: "Bola", role: "Engineer", focus: "systems" },
  { name: "Chidi", role: "Manager", focus: "delivery" },
];
const base = { candidateName: "Daniel", timeOfDay: "morning" };
const spine = [{ question: "Tell me about yourself" }];

const MODES = {
  solo: () => ai.buildRealtimeInstructions(ctx, { jobTitle: "PM", company: "Acme" }, spine, 10, base),
  "pick-a-role": () =>
    ai.buildRealtimeInstructions(ctx, { jobTitle: "PM" }, spine, 10, {
      ...base,
      interviewer: { name: "Ada", role: "HR Manager", focus: "fit" },
    }),
  "single-voice panel": () =>
    ai.buildRealtimeInstructions(ctx, { jobTitle: "PM" }, spine, 10, {
      ...base,
      panel,
      panelMode: "single-voice",
    }),
  "multi-voice seat": () =>
    ai.buildRealtimeInstructions(ctx, { jobTitle: "PM" }, spine, 10, {
      ...base,
      panel,
      panelMode: "multi-voice",
      segment: { index: 0, isFirst: true, isLast: false },
    }),
};

const eachMode = (fn) =>
  Object.entries(MODES).forEach(([name, build]) => {
    // eslint-disable-next-line jest/valid-title
    it(name, () => fn(build()));
  });

describe("realism boundary is present in every mode", () => {
  eachMode((p) => {
    expect(p).toMatch(/warm in MANNER, neutral in CONTENT/);
    expect(p).toMatch(/No reassurance of any kind/i);
    expect(p).toMatch(/No teaching and no frameworks mid-interview/i);
    expect(p).toMatch(/No progress commentary/i);
    expect(p).toMatch(/No praise/i);
  });
});

describe("what the room keeps doing, because real interviewers do", () => {
  eachMode((p) => {
    expect(p).toMatch(/rephrase the question/i); // blank → different door in
    expect(p).toMatch(/offer a concrete anchor/i); // stall → anchor, then wait
    expect(p).toMatch(/AT MOST ONCE in the whole session/i); // "take your time"
    expect(p).toMatch(/THIS NEVER SOFTENS/); // thin answers still get pushed
    expect(p).toMatch(/The manner adapts; the substance does not/i);
  });
});

describe("no reassurance, praise or coaching language survives anywhere", () => {
  // These are the exact strings the old prompt used. Absence is meaningful only
  // because the prohibitions above are phrased WITHOUT quoting them back.
  const REMOVED = [
    /you're doing fine/i,
    /don't worry/i,
    /great answer/i,
    /love that/i,
    /\bencouraging\b/i,
    /build their confidence/i,
    /friendly coach/i,
    /gentle nudges/i,
    /that was better/i,
    /warming up/i,
  ];
  eachMode((p) => REMOVED.forEach((re) => expect(p).not.toMatch(re)));
});

describe("no recitable sentences in the greeting or acknowledgement instructions", () => {
  // Every scripted line the model could read aloud verbatim.
  const SCRIPTS = [
    /great to have you/i,
    /Got it, than/i,
    /That makes sense/i,
    /Interesting — tell me more/i,
    /I believe you're here for/i,
    /That's interesting, but it doesn't quite answer/i,
  ];
  eachMode((p) => SCRIPTS.forEach((re) => expect(p).not.toMatch(re)));
});

describe("the reassurance ban is as assertable as the praise ban (Phase 4 carry-over)", () => {
  // Phrased descriptively so the banned phrases do not appear in the prompt at all.
  eachMode((p) => {
    expect(p).toMatch(/do not comment on how they are performing/i);
    expect(p).not.toMatch(/doing fine/i);
    expect(p).not.toMatch(/not to worry/i);
    expect(p).not.toMatch(/a hard one/i);
  });
});

describe("humour has a timing guardrail (Phase 4 carry-over)", () => {
  eachMode((p) => {
    expect(p).toMatch(/never at the candidate's expense/i);
    expect(p).toMatch(/after they have frozen, floundered or failed to answer/i);
  });
});

describe("scripted-line audit — no recitable interviewer sentences remain", () => {
  // Anything the model could read out verbatim. The survivors are deliberate and
  // listed here: question-TYPE labels, the spine's own seed question, and topic
  // names — none of which is a sentence to speak.
  const ALLOWED = [
    /^tell me about a time…$/i,
    /^walk me through how you'd…$/i,
    /^how would you handle…$/i,
    /^why are you a good fit for this$/i,
    /^Tell me about yourself$/i, // the caller's seed question, i.e. data not script
  ];
  eachMode((p) => {
    const quoted = [...p.matchAll(/"([^"\n]{8,140})"/g)].map((m) => m[1]);
    const offenders = quoted.filter((q) => !ALLOWED.some((re) => re.test(q)));
    expect(offenders).toEqual([]);
  });
});

describe("the interviewer is not nudged into jumping in", () => {
  // Phase 1 set semantic_vad/low so candidates get time to think. A prompt line
  // telling the model not to leave pauses works against that patience.
  eachMode((p) => {
    expect(p).not.toMatch(/do NOT drag or leave long pauses/i);
    expect(p).not.toMatch(/with no long pauses/i);
    expect(p).toMatch(/still thinking, so do not fill it/i);
  });
});

describe("challenge levels differ by pressure, not by comfort", () => {
  const at = (challenge) =>
    ai.buildRealtimeInstructions(ctx, { jobTitle: "PM" }, spine, 10, { ...base, challenge });

  it("gentle presses least but still never coaches or praises", () => {
    const p = at("gentle");
    expect(p).toMatch(/CHALLENGE LEVEL — LOW PRESSURE/);
    expect(p).toMatch(/take a reasonable answer at face value/i);
    expect(p).toMatch(/Do NOT stack follow-ups/i);
    expect(p).toMatch(/you still never coach, teach, praise or reassure/i);
  });

  it("the three levels are genuinely different instructions", () => {
    const g = at("gentle");
    const r = at("realistic");
    const t = at("tough");
    expect(g).toMatch(/LOW PRESSURE/);
    expect(r).toMatch(/REALISTIC/);
    expect(t).toMatch(/TOUGH/);
    // Each carries a distinct pressure instruction the others do not.
    expect(g).toMatch(/take a reasonable answer at face value/i);
    expect(r).not.toMatch(/take a reasonable answer at face value/i);
    expect(t).not.toMatch(/take a reasonable answer at face value/i);
    expect(t).toMatch(/pressure-test their claims/i);
    expect(g).not.toMatch(/pressure-test their claims/i);
    expect(r).toMatch(/ask for specifics and evidence/i);
  });

  it("every level still sits inside the boundary", () => {
    ["gentle", "realistic", "tough"].forEach((c) => {
      expect(at(c)).toMatch(/warm in MANNER, neutral in CONTENT/);
      expect(at(c)).toMatch(/No praise/i);
    });
  });
});

describe("phase 1 and 2 work is untouched", () => {
  eachMode((p) => {
    expect(p).toMatch(/VERIFY, NEVER PROSECUTE/); // two-way CV grounding
    expect(p).toMatch(/ANTI-HALLUCINATION RULES/);
    expect(p).toMatch(/untrusted data/); // injection defense
  });

  it("panel mechanics and time management survive", () => {
    const mv = MODES["multi-voice seat"]();
    expect(mv).toMatch(/hand_off_to_next/);
    const sv = MODES["single-voice panel"]();
    expect(sv).toMatch(/set_active_speaker/);
    expect(MODES.solo()).toMatch(/HANDLING TIME RUNNING OUT/);
  });
});

describe("stage changes the evidence base, not the room (Phase 5)", () => {
  const arch = require("../src/services/interviewArchetypes.service");
  const withArch = (archetype) =>
    ai.buildRealtimeInstructions(ctx, { jobTitle: "PM" }, spine, 10, { ...base, archetype });

  const grad = withArch(arch.getArchetype("behavioural", "grad"));
  const exp = withArch(arch.getArchetype("behavioural", "experienced"));

  it("points a graduate's interview at projects, societies and NYSC", () => {
    expect(grad).toMatch(/NYSC/);
    expect(grad).toMatch(/final-year projects/i);
    expect(grad).toMatch(/normal place to look rather than a concession/i);
    expect(exp).not.toMatch(/NYSC/);
  });

  it("does NOT lower the pressure for a graduate", () => {
    expect(grad).toMatch(/same pressure, same standards, same follow-ups/i);
    // The realism boundary is byte-identical at both stages.
    [/warm in MANNER, neutral in CONTENT/, /THIS NEVER SOFTENS/, /No praise/i, /No reassurance/i].forEach(
      (re) => {
        expect(grad).toMatch(re);
        expect(exp).toMatch(re);
      }
    );
  });

  it("keeps the challenge level and boundary identical across stages", () => {
    // Strip the one block that is meant to differ; the rest must match exactly.
    const strip = (s) => s.replace(/WHERE THEIR EVIDENCE LIVES:[^\n]*\n/, "");
    expect(strip(grad)).toBe(strip(exp));
  });

  it("still passes the scripted-line audit with an archetype attached", () => {
    const quoted = [...grad.matchAll(/"([^"\n]{8,140})"/g)].map((m) => m[1]);
    const allowed = [/^tell me about a time…$/i, /^walk me through how you'd…$/i, /^how would you handle…$/i, /^why are you a good fit for this$/i, /^Tell me about yourself$/i];
    expect(quoted.filter((q) => !allowed.some((re) => re.test(q)))).toEqual([]);
  });
});

// ===========================================================================
// PHASE 5b — THE TYPED ENGINE MUST MATCH THE LIVE ROOM
// ===========================================================================
// Typed practice burns no realtime minutes, so it is plausibly where free users
// and first-timers land. If it kept the old coaching persona, the cheap tier
// would get the kind room and the paid tier the real one. These assertions live
// in the SAME file as the live-engine ones on purpose: the two cannot drift
// without a failure here.
describe("typed engine (conversationTurn) parity", () => {
  const arch = require("../src/services/interviewArchetypes.service");
  const variation = require("../src/services/interviewVariation.service");

  const typedPrompt = async (extra = {}) => {
    sent.length = 0;
    await ai.conversationTurn(
      {
        questionSpine: spine,
        spineIndex: 0,
        transcript: [{ role: "candidate", text: "I built a results portal with three friends." }],
        lastAnswer: "I built a results portal with three friends.",
        phase: "answer",
        candidateName: "Daniel",
        ...extra,
      },
      ctx,
      { jobTitle: "PM", company: "Acme" },
      {}
    );
    return sent[0].messages.find((m) => m.role === "system").content;
  };

  it("carries the realism boundary", async () => {
    const p = await typedPrompt();
    expect(p).toMatch(/warm in MANNER, neutral in CONTENT/);
    expect(p).toMatch(/No reassurance of any kind/i);
    expect(p).toMatch(/No teaching and no frameworks mid-interview/i);
    expect(p).toMatch(/No progress commentary/i);
    expect(p).toMatch(/No praise/i);
    expect(p).toMatch(/THIS NEVER SOFTENS/);
  });

  it("carries the two-way CV grounding, all three tiers", async () => {
    const p = await typedPrompt();
    expect(p).toMatch(/VERIFY, NEVER PROSECUTE/);
    expect(p).toMatch(/THEIR NAME \(the record says Daniel\)/);
    expect(p).toMatch(/GENUINE CONFLICTS/);
    expect(p).toMatch(/THINGS SIMPLY NOT ON THE CV ARE NOT CONFLICTS/);
  });

  it("has the same coaching language absent as the live engine", async () => {
    const p = await typedPrompt();
    [
      /you're doing fine/i,
      /don't worry/i,
      /great answer/i,
      /love that/i,
      /\bencouraging\b/i,
      /light humor/i,
      /warm reaction/i,
      /warm beat/i,
      /set them at ease/i,
      /small talk/i,
    ].forEach((re) => expect(p).not.toMatch(re));
  });

  it("drops the voice-only lines rather than transplanting them", async () => {
    const p = await typedPrompt();
    // "Take your time" and pacing are meaningless to someone typing.
    expect(p).not.toMatch(/AT MOST ONCE in the whole session/);
    expect(p).not.toMatch(/slow down, keep your tone kind/);
    expect(p).not.toMatch(/their voice is shaking/);
    // …but the substance-side rule survives in adapted form.
    expect(p).toMatch(/The manner adapts; the substance does not/);
    expect(p).toMatch(/however hesitant they seem/);
  });

  it("keeps the TTS contract intact", async () => {
    const p = await typedPrompt();
    expect(p).toMatch(/read aloud by text-to-speech/);
    expect(p).toMatch(/"spoken"/);
    expect(p).toMatch(/"displayQuestion"/);
  });

  it("uses the cross-turn advantage it has over the voice engine", async () => {
    // It round-trips per turn, so it can see the whole conversation and check a
    // claim against an EARLIER answer, not just against the CV. No extra AI call.
    const p = await typedPrompt();
    expect(p).toMatch(/CONFLICTS with something they said earlier in this interview/i);
  });

  it("takes the archetype and its exclusions", async () => {
    const p = await typedPrompt({ archetype: arch.getArchetype("behavioural", "grad") });
    expect(p).toMatch(/ROUGHLY THE GROUND TO COVER/);
    expect(p).toMatch(/WHAT MUST NOT COUNT AGAINST THEM/);
    expect(p).toMatch(/NYSC/); // graduate evidence base
  });

  it("takes the variation plan", async () => {
    const plan = variation.planSession({ pool: ["dbt", "SQL"], history: [] });
    const p = await typedPrompt({ variation: plan });
    expect(p).toMatch(/THIS SESSION'S SHAPE/);
    expect(p).toMatch(/NOT a rule against repeating questions/i);
  });

  it("renders nothing extra when archetype and variation are absent", async () => {
    const p = await typedPrompt();
    expect(p).not.toMatch(/ROUGHLY THE GROUND TO COVER/);
    expect(p).not.toMatch(/THIS SESSION'S SHAPE/);
    // The boundary and grounding are unconditional, though.
    expect(p).toMatch(/warm in MANNER, neutral in CONTENT/);
  });

  it("passes the scripted-line audit — never swept before this phase", async () => {
    const p = await typedPrompt({ archetype: arch.getArchetype("screening", "grad") });
    // Drop the JSON return-contract first: its quoted field NAMES are the output
    // schema, not anything the interviewer could say out loud.
    const body = p.split("Return JSON matching exactly:")[0];
    const quoted = [...body.matchAll(/"([^"\n]{8,140})"/g)].map((m) => m[1]);
    // The only survivors are the output-contract identifiers themselves — a JSON
    // field name and a phase name. Neither is a sentence anyone could say.
    expect(quoted.filter((q) => !["displayQuestion", "greeting"].includes(q))).toEqual([]);
  });

  it("still returns a usable turn", async () => {
    sent.length = 0;
    const out = await ai.conversationTurn(
      {
        questionSpine: [...spine, { question: "Why this role?" }],
        spineIndex: 0,
        phase: "greeting",
      },
      ctx,
      { jobTitle: "PM" },
      {}
    );
    expect(out.spoken).toBe("…");
    expect(out.nextSpineIndex).toBe(1);
    expect(out.done).toBe(false);
  });
});
