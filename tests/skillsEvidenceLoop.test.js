// Closing the skills loop. Three things were broken and are tested here:
//
//  1. The interview ledger never reached skills generation — everything a user confirmed
//     while building their work history was discarded before their skills were written.
//  2. "Best for this role" was PURE keyword matching. A starred skill meant "resembles a
//     JD keyword", and every row was stamped evidenceStatus 'demonstrated' regardless of
//     how much actually backed it.
//  3. The scan's missing keywords were displayed to the user and then not passed to the
//     generator that was supposed to act on them.
//
// The OpenAI SDK is mocked so the real prompt assembly and the real server-side evidence
// enforcement both run unmocked.
process.env.OPENAI_API_KEY = "k-openai";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const mockOpenAICreate = jest.fn();
const mockOpenAICtor = jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockOpenAICreate } },
}));
jest.mock("openai", () => mockOpenAICtor);
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn().mockResolvedValue({}) }));

const ai = require("../src/services/ai.service");

const EXPERIENCE = [
  { _sortId: "e1", title: "Ward Nurse", company: "St Mary's", description: "Ran handovers." },
];
const PROJECTS = [];
const EDUCATION = [{ _sortId: "d1", degree: "BSc", field: "Nursing", school: "UNILAG" }];

const INTERVIEW = [
  {
    evidenceId: "ev_1",
    type: "experience",
    refIndex: 0,
    claim: "Ran the ward handover every shift",
    sourceQuote: "I ran the ward handover every shift using the triage board.",
    tools: ["Triage board"],
    requirementIds: ["req_triage"],
  },
];

const BRIEF = {
  role: "Staff Nurse",
  mustHaves: [{ name: "Triage", importance: "must_have" }],
  niceToHaves: [],
  responsibilities: [],
  requirements: [
    {
      id: "req_triage",
      name: "Triage",
      type: "domain",
      priority: "must_have",
      aliases: ["Triage assessment"],
      proofSignals: ["prioritised patients", "assessed on arrival"],
    },
    {
      id: "req_cert",
      name: "BLS Certification",
      type: "certification",
      priority: "must_have",
      aliases: [],
      proofSignals: [],
    },
  ],
};

// generateSkillsFromContext makes a SECOND call (organizeSkillCategoryAssignments), so
// queue a category response behind the generation response.
const skillsReply = (payload) => ({
  choices: [{ message: { content: JSON.stringify(payload) } }],
  usage: {},
});
const categoriesReply = () => skillsReply({ skills: [] });

// generateSkillsFromContext sends its whole prompt as a single `user` message through
// callModel, so join every part rather than assuming a position.
const generationPrompt = () =>
  (mockOpenAICreate.mock.calls[0][0].messages || []).map((m) => m.content || "").join("\n");

const run = (options = {}) =>
  ai.generateSkillsFromContext(EDUCATION, EXPERIENCE, PROJECTS, "", false, {
    modelId: "gpt-4o-mini",
    meta: {},
    ...options,
  });

beforeEach(() => mockOpenAICreate.mockReset());

describe("the interview ledger reaches skills generation", () => {
  it("offers the candidate's own verified words, at equal standing to the CV text", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    await run({ interviewEvidence: INTERVIEW });
    const prompt = generationPrompt();

    expect(prompt).toMatch(/INTERVIEW EVIDENCE/);
    // The id must be shown QUOTED. It was labelled "[ie0]" — the same notation this
    // prompt uses for the NUMERIC refIndex ([0] Ward Nurse at St Mary's) — which taught
    // the model to copy the bracketed token straight into the array as
    // "interviewEvidenceIds": [ie5]. That is not valid JSON, and it threw away the whole
    // generation for every user who had actually done an interview.
    expect(prompt).toMatch(/id "ie0"/);
    expect(prompt).not.toMatch(/\[ie0\]/);
    expect(prompt).toMatch(/Ran the ward handover every shift/);
    expect(prompt).toMatch(/TOOLS THEY NAMED: Triage board/);
    expect(prompt).toMatch(/EQUAL standing/i);
    expect(prompt).toMatch(/interviewEvidenceIds/);
  });

  it("omits the block entirely when no interview has happened", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    await run();
    expect(generationPrompt()).not.toMatch(/INTERVIEW EVIDENCE/);
  });

  // A skill the user NAMED in a verified quote is the strongest evidence available, so it
  // must be allowed to stand on its own without a separate CV-text citation.
  it("accepts a skill proven ONLY by the interview", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(
        skillsReply({
          suggestions: [
            {
              category: "Clinical Practice",
              skills: ["Triage", "Handover"],
              skillsDetailed: [
                { name: "Triage", evidence: [], interviewEvidenceIds: ["ie0"] },
                {
                  name: "Handover",
                  evidence: [{ type: "experience", refIndex: 0, snippet: "Ran handovers" }],
                  interviewEvidenceIds: [],
                },
              ],
            },
          ],
          confirmationCandidates: [],
        })
      )
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ interviewEvidence: INTERVIEW });
    const all = out.suggestions.flatMap((g) => g.skillsDetailed);
    const triage = all.find((s) => s.name === "Triage");

    expect(triage).toBeTruthy();
    expect(triage.interviewEvidence[0].sourceQuote).toMatch(/I ran the ward handover/);
    expect(triage.interviewEvidence[0].fromInterview).toBe(true);
    expect(triage.interviewEvidence[0].requirementIds).toEqual(["req_triage"]);
  });

  // The whole point of server-side enforcement: a citation the model invented must not
  // become support. Same discipline refIndex already gets.
  it("drops a skill whose ONLY support is an interview id that does not exist", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(
        skillsReply({
          suggestions: [
            {
              category: "Clinical Practice",
              skills: ["Phlebotomy", "Handover"],
              skillsDetailed: [
                { name: "Phlebotomy", evidence: [], interviewEvidenceIds: ["ie99"] },
                {
                  name: "Handover",
                  evidence: [{ type: "experience", refIndex: 0, snippet: "Ran handovers" }],
                  interviewEvidenceIds: [],
                },
              ],
            },
          ],
          confirmationCandidates: [],
        })
      )
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ interviewEvidence: INTERVIEW });
    const names = out.suggestions.flatMap((g) => g.skills);

    expect(names).not.toContain("Phlebotomy");
    expect(names).toContain("Handover");
  });
});

describe("the typed requirement checklist reaches the prompt", () => {
  it("sends type, priority, aliases and proof signals — not just bare names", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    await run({ brief: BRIEF });
    const prompt = generationPrompt();

    expect(prompt).toMatch(/TYPED REQUIREMENTS/);
    expect(prompt).toMatch(/Triage \[domain, must_have\]/);
    expect(prompt).toMatch(/also called: Triage assessment/);
    expect(prompt).toMatch(/evidence signals: prioritised patients; assessed on arrival/);
    // Type-awareness is what lets the model tell a credential from a skill.
    expect(prompt).toMatch(/BLS Certification \[certification, must_have\]/);
    // The invariant that must survive: leads, never proof.
    expect(prompt).toMatch(/INVESTIGATION LEADS/);
    expect(prompt).toMatch(/must be NAMED in the profile/i);
  });
});

describe("the scan's missing keywords reach the generator", () => {
  it("passes them as a search list, explicitly not a licence", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    await run({ brief: BRIEF, missingKeywords: ["Triage", "Wound care"] });
    const prompt = generationPrompt();

    expect(prompt).toMatch(/ALREADY IDENTIFIED AS MISSING FROM THIS CV: Triage, Wound care/);
    expect(prompt).toMatch(/SEARCH LIST, NOT A LICENCE/);
    expect(prompt).toMatch(/output one ONLY if you find real support/i);
    expect(prompt).toMatch(/its absence is an honest gap/i);
  });

  it("adds nothing when the scan found no skills gaps", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    await run({ brief: BRIEF });
    expect(generationPrompt()).not.toMatch(/ALREADY IDENTIFIED AS MISSING/);
  });
});

describe("career stage reaches the skills prompt", () => {
  it("carries the stage directive with the skills section note", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    await run({ stage: "grad" });
    const prompt = generationPrompt();

    expect(prompt).toMatch(/CANDIDATE STAGE/);
    expect(prompt).toMatch(/SECTION NOTE — SKILLS/);
    expect(prompt).toMatch(/not a headline strength/i);
  });
});

describe("the raw JD is truncated like every other JD prompt", () => {
  it("does not inject an unbounded job description", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    const huge = "ward duties ".repeat(4000); // ~48k chars
    await ai.generateSkillsFromContext(EDUCATION, EXPERIENCE, PROJECTS, huge, false, {
      modelId: "gpt-4o-mini",
      meta: {},
    });

    expect(generationPrompt().length).toBeLessThan(huge.length);
  });
});

// A production failure, reproduced. The model answered with
//   "interviewEvidenceIds": [ie5],
// a bare token where JSON requires a quoted string. JSON.parse threw, the catch swallowed
// it into an empty result, and the user was told to add more detail to a CV that was
// already full. Two things caused it: the prompt taught the bracket notation, and the
// output example never showed the field at all — so prose was the model's only guidance.
describe("the interview citation field cannot invite invalid JSON", () => {
  const promptFor = async (options) => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());
    await run(options);
    return generationPrompt();
  };

  it("shows the exact shape it wants, not only a description of it", async () => {
    const prompt = await promptFor({ interviewEvidence: INTERVIEW });

    expect(prompt).toMatch(/"interviewEvidenceIds": \["ie0"\]/);
    expect(prompt).toMatch(/QUOTED STRING ids/);
    // Nowhere may the prompt suggest an unquoted token inside the array.
    expect(prompt).not.toMatch(/\[ieN\]/);
    expect(prompt).not.toMatch(/interviewEvidenceIds": \[ie/);
  });

  it("keeps the field out of the example when there is nothing to cite", async () => {
    // An example referring to a block that isn't in the prompt is how invented ids start.
    const prompt = await promptFor({});

    expect(prompt).not.toMatch(/interviewEvidenceIds/);
  });

  it("asks the provider to enforce JSON rather than trusting the model", async () => {
    await promptFor({ interviewEvidence: INTERVIEW });

    expect(mockOpenAICreate.mock.calls[0][0].response_format).toEqual({ type: "json_object" });
  });
});

describe("a broken generation is reported as broken", () => {
  it("still recovers a reply that JSON mode did not constrain", async () => {
    // Belt and braces: a provider that ignores JSON mode, or wraps the object in prose,
    // must not cost the user a generation the model actually completed.
    mockOpenAICreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: `Here are the skills:\n\`\`\`json\n${JSON.stringify({
                suggestions: [
                  {
                    category: "Clinical Practice",
                    skills: ["Handover"],
                    skillsDetailed: [
                      {
                        name: "Handover",
                        evidence: [{ type: "experience", refIndex: 0, snippet: "Ran handovers" }],
                      },
                    ],
                  },
                ],
                confirmationCandidates: [],
              })}\n\`\`\`\nHope that helps.`,
            },
          },
        ],
        usage: {},
      })
      .mockResolvedValueOnce(categoriesReply());

    const result = await run({});
    expect(result.failed).toBeUndefined();
    expect(result.suggestions.flatMap((g) => g.skills)).toContain("Handover");
  });

  it("flags a genuine failure so it is never reported as a thin profile", async () => {
    // The whole point: "the call broke" and "the model found nothing it could evidence"
    // both produce an empty list, but they are opposite messages to the user. One is
    // retryable and not their fault; the other means their CV is too thin.
    mockOpenAICreate.mockRejectedValueOnce(new Error("upstream exploded"));

    const result = await run({});
    expect(result.suggestions).toEqual([]);
    expect(result.failed).toBe(true);
  });

  it("does not flag an honestly empty result", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    const result = await run({});
    expect(result.suggestions).toEqual([]);
    expect(result.failed).toBeUndefined();
  });
});

// ─── The role canon ───
//
// Every other input to this generation is drawn from the user's own words, which is why
// the skills section could only read those words back to them. A CV saying "Plumber —
// fixed pipes" contains no soldering, so no amount of prompting could produce soldering,
// and with no job description the prompt said, in full, "NO TARGET ROLE BRIEF" — the
// generator had never been told what the trade involves.
//
// The canon is that missing input: what a competent holder of the user's OWN roles would
// normally know. It is a statement about the occupation, never about the person, so it can
// only ever produce a QUESTION — never a skill on the CV.
const CANON = [
  {
    id: "exp0",
    label: "Plumber",
    source: "experience",
    refIndex: 0,
    skills: [
      {
        name: "Soldering copper joints",
        category: "Pipework",
        why: "Standard for domestic installs",
      },
      { name: "Pressure testing", category: "Commissioning", why: "Required before sign-off" },
    ],
  },
];

const canonPrompt = async (options) => {
  mockOpenAICreate
    .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
    .mockResolvedValueOnce(categoriesReply());
  await run(options);
  return generationPrompt();
};

describe("what people in the user's roles normally know reaches the prompt", () => {
  it("replaces the bare no-brief line, which told the model nothing at all", async () => {
    const prompt = await canonPrompt({ roleCanon: CANON });

    expect(prompt).toMatch(/TYPICAL FOR THEIR ROLES/);
    expect(prompt).toMatch(/Soldering copper joints/);
    expect(prompt).toMatch(/typicalFor id "exp0"/);
    // The dead end: "rank by evidence" and nothing else. It must no longer stand alone.
    expect(prompt).toMatch(
      /use TYPICAL FOR THEIR ROLES below to decide what is worth asking about/
    );
  });

  it("frames it as an occupation, never as a claim about this person", async () => {
    // The single most important line in the block. Without it the model reads the canon as
    // a list of things the candidate has done.
    const prompt = await canonPrompt({ roleCanon: CANON });

    expect(prompt).toMatch(/statement about the OCCUPATION, NEVER about this person/);
    expect(prompt).toMatch(/is not evidence and can never prove a skill/);
  });

  it("keeps the JD lens too — the two answer different questions", async () => {
    // The JD decides what matters; the canon catches what the user did but never wrote
    // down. A user who supplied a JD should not lose the second one.
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());
    await ai.generateSkillsFromContext(EDUCATION, EXPERIENCE, PROJECTS, "Maintenance role", false, {
      modelId: "gpt-4o-mini",
      meta: {},
      brief: BRIEF,
      roleCanon: CANON,
    });
    const prompt = generationPrompt();

    expect(prompt).toMatch(/TYPED REQUIREMENTS/);
    expect(prompt).toMatch(/TYPICAL FOR THEIR ROLES/);
  });

  it("says nothing when there is no canon to say", async () => {
    expect(await canonPrompt({})).not.toMatch(/TYPICAL FOR THEIR ROLES/);
  });
});

describe("a role-typical skill can only ever become a question", () => {
  const reply = (candidate) =>
    skillsReply({
      suggestions: [
        {
          category: "Pipework",
          skills: ["Pipe repair"],
          skillsDetailed: [
            {
              name: "Pipe repair",
              evidence: [{ type: "experience", refIndex: 0, snippet: "Ran handovers" }],
            },
          ],
        },
      ],
      confirmationCandidates: [candidate],
    });

  it("survives with NO profile evidence, because the role is what grounds it", async () => {
    // The whole feature in one assertion. "Plumbers solder" is grounded in the trade, not
    // in this CV — under the old rule it was dropped for having no citation, which is
    // exactly why the section could never tell anyone anything they had not already typed.
    mockOpenAICreate
      .mockResolvedValueOnce(
        reply({
          name: "Soldering copper joints",
          category: "Pipework",
          typicalFor: "exp0",
          reason: "Standard for domestic installs",
          question: "Plumbers usually solder copper joints. Did you?",
          evidence: [],
        })
      )
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: CANON });
    const candidate = out.confirmationCandidates.find(
      (row) => row.name === "Soldering copper joints"
    );

    expect(candidate).toBeTruthy();
    expect(candidate.typicalForLabel).toBe("Plumber");
    // And it is NOT a skill: nothing reaches the CV until the user answers the question.
    expect(out.suggestions.flatMap((g) => g.skills)).not.toContain("Soldering copper joints");
  });

  it("is dropped when it claims a role the candidate does not have", async () => {
    // The refIndex discipline, applied to role claims: an id the model invented cannot
    // ground anything, so "typical for Surgeon" on a plumber's CV goes nowhere.
    mockOpenAICreate
      .mockResolvedValueOnce(
        reply({
          name: "Suturing",
          category: "Clinical",
          typicalFor: "exp99",
          reason: "Typical for a surgeon",
          question: "Did you suture?",
          evidence: [],
        })
      )
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: CANON });
    expect(out.confirmationCandidates.map((row) => row.name)).not.toContain("Suturing");
  });

  it("still accepts the old profile-activity route", async () => {
    // Canon-grounding is an ADDITIONAL door, not a replacement: a candidate justified by
    // something in the CV needs no typicalFor at all.
    mockOpenAICreate
      .mockResolvedValueOnce(
        reply({
          name: "Triage",
          category: "Clinical Practice",
          reason: "The handover work suggests it",
          question: "Did you triage on those shifts?",
          evidence: [{ type: "experience", refIndex: 0, snippet: "Ran handovers" }],
        })
      )
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({});
    expect(out.confirmationCandidates.map((row) => row.name)).toContain("Triage");
  });
});

describe("the count is a ceiling, not a quota", () => {
  it("asks for the number the user picked, and forbids padding in the same breath", async () => {
    const prompt = await canonPrompt({ count: 20, roleCanon: CANON });

    expect(prompt).toMatch(/Generate UP TO 20 of the strongest supported skills/);
    expect(prompt).toMatch(/20 is a CEILING, not a target/);
    // The anti-padding clause is the reason a count is safe to offer at all. If a future
    // edit drops it, a user asking for 20 gets 20 invented skills.
    expect(prompt).toMatch(/NEVER pad the list to reach it/);
  });

  // One assertion each: generationPrompt() reads mock call [0], so two generations in a
  // single test would both be measured against the first one's prompt.
  it("clamps a count above the ceiling", async () => {
    expect(await canonPrompt({ count: 500, roleCanon: CANON })).toMatch(/Generate UP TO 20 /);
  });

  it("clamps a count below the floor", async () => {
    expect(await canonPrompt({ count: 1, roleCanon: CANON })).toMatch(/Generate UP TO 5 /);
  });

  it("defaults to 15 when the client sends nothing", async () => {
    expect(await canonPrompt({ roleCanon: CANON })).toMatch(/Generate UP TO 15 /);
  });

  it("lets the confirmation list grow with it — a thin profile needs the questions most", async () => {
    // Asking for 20 on a CV that supports 6 is exactly when the user needs something to
    // answer. The old flat cap of 5 made the big count pointless.
    expect(await canonPrompt({ count: 20, roleCanon: CANON })).toMatch(
      /return up to 20 "confirmationCandidates"/
    );
  });
});

describe("roleSkillCanon", () => {
  const canonReply = (payload) => ({
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: {},
  });

  it("asks about the occupation and returns its vocabulary", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      canonReply({
        roles: [
          { id: "exp0", skills: [{ name: "Pipe threading", category: "Pipework", why: "std" }] },
        ],
      })
    );

    const out = await ai.roleSkillCanon({
      roles: [{ title: "Plumber", company: "Ace Ltd" }],
      meta: {},
    });

    expect(out[0].label).toBe("Plumber");
    expect(out[0].skills[0].name).toBe("Pipe threading");
    const sent = (mockOpenAICreate.mock.calls[0][0].messages || [])
      .map((m) => m.content || "")
      .join("\n");
    expect(sent).toMatch(/id exp0 \[experience\] Plumber/);
    expect(sent).toMatch(/about the OCCUPATION, not about any person/);
  });

  it("discards a role id it was never given", async () => {
    mockOpenAICreate.mockResolvedValueOnce(
      canonReply({ roles: [{ id: "exp7", skills: [{ name: "Ghost skill" }] }] })
    );

    expect(await ai.roleSkillCanon({ roles: [{ title: "Plumber" }], meta: {} })).toEqual([]);
  });

  it("makes no call at all when there is nothing to look up", async () => {
    expect(await ai.roleSkillCanon({ meta: {} })).toEqual([]);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it("degrades to today's behaviour rather than costing a generation", async () => {
    // The canon makes skills better; it is not required for them. A failure must leave the
    // user with evidence-only skills, not with an error.
    mockOpenAICreate.mockRejectedValueOnce(new Error("upstream down"));

    expect(await ai.roleSkillCanon({ roles: [{ title: "Plumber" }], meta: {} })).toEqual([]);
  });
});

// ─── The canon may not promote anything ───
//
// Measured against the real model, not imagined. Given "Plumber — fixed pipes and attended
// callouts" and a canon naming soldering, pressure testing and drain cleaning, gpt-4o-mini
// returned all three as PROVEN, citing the single experience entry for each with a
// plausible-sounding paraphrase. The evidence gate could not catch it: a citation only has
// to RESOLVE to a real entry, and every one of them did.
//
// So the rule is enforced in code rather than asked for in the prompt. Without these tests
// the feature quietly becomes "put skills you have never done on your CV".
const MIXED_CANON = [
  {
    id: "exp0",
    label: "Ward Nurse",
    source: "experience",
    refIndex: 0,
    skills: [
      // The profile says "Ran handovers." — this one the user's own words support.
      { name: "Shift handovers", category: "Ward Practice", why: "Every shift" },
      // These two it does not mention at all.
      { name: "Cannulation", category: "Clinical Procedures", why: "Routine on most wards" },
      { name: "Wound dressing", category: "Clinical Procedures", why: "Routine on most wards" },
    ],
  },
];

const claimsAsProven = (names) =>
  skillsReply({
    suggestions: [
      {
        category: "Clinical Practice",
        skills: names,
        skillsDetailed: names.map((name) => ({
          name,
          // A resolvable citation with a confident paraphrase — exactly what the model
          // produced in production, and exactly what the old gate waved through.
          evidence: [{ type: "experience", refIndex: 0, snippet: "Ward work at St Mary's" }],
        })),
      },
    ],
    confirmationCandidates: [],
  });

describe("a canon skill is proven only by the user's own words", () => {
  it("demotes a claimed skill the profile never mentions to a question", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(claimsAsProven(["Cannulation"]))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: MIXED_CANON });

    expect(out.suggestions.flatMap((g) => g.skills)).not.toContain("Cannulation");
    const asked = out.confirmationCandidates.find((row) => row.name === "Cannulation");
    expect(asked).toBeTruthy();
    expect(asked.typicalForLabel).toBe("Ward Nurse");
  });

  it("keeps one the profile DOES mention", async () => {
    // The guard must not swallow real skills: "Ran handovers." supports "Shift handovers".
    mockOpenAICreate
      .mockResolvedValueOnce(claimsAsProven(["Shift handovers"]))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: MIXED_CANON });
    expect(out.suggestions.flatMap((g) => g.skills)).toContain("Shift handovers");
  });

  it("leaves skills the canon never named alone", async () => {
    // The guard is scoped to canon names. Everything else keeps exactly the evidence gate
    // it had before this feature existed.
    mockOpenAICreate
      .mockResolvedValueOnce(claimsAsProven(["Triage"]))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: MIXED_CANON });
    expect(out.suggestions.flatMap((g) => g.skills)).toContain("Triage");
  });

  it("counts the interview as the user's own words too", async () => {
    // A skill the user NAMED in a verified interview turn is supported even when the CV
    // text is silent — the ledger is their words, just captured elsewhere.
    mockOpenAICreate
      .mockResolvedValueOnce(claimsAsProven(["Cannulation"]))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({
      roleCanon: MIXED_CANON,
      interviewEvidence: [
        {
          evidenceId: "ev_2",
          type: "experience",
          refIndex: 0,
          claim: "Performed cannulation on the ward",
          sourceQuote: "I did cannulation most shifts.",
          tools: [],
          requirementIds: [],
        },
      ],
    });

    expect(out.suggestions.flatMap((g) => g.skills)).toContain("Cannulation");
  });

  it("fills the questions from the canon rather than trusting the model to volunteer them", async () => {
    // The model treats "return up to N candidates" as permission: handed EIGHT unprovable
    // trade skills it offered one. Every canon skill not proven becomes a question here.
    mockOpenAICreate
      .mockResolvedValueOnce(claimsAsProven(["Shift handovers"]))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: MIXED_CANON });
    const asked = out.confirmationCandidates.map((row) => row.name);

    expect(asked).toContain("Cannulation");
    expect(asked).toContain("Wound dressing");
    // The proven one is not also asked about.
    expect(asked).not.toContain("Shift handovers");
  });

  it("does not ask about a near-duplicate of something already proven", async () => {
    // "Ward handovers" offered as a question directly beneath "Shift handovers" on the CV
    // reads as a bug. Exact-identity matching cannot catch it; word containment can.
    mockOpenAICreate
      .mockResolvedValueOnce(claimsAsProven(["Handovers"]))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({
      roleCanon: [
        {
          ...MIXED_CANON[0],
          skills: [{ name: "Ward handovers", category: "Ward Practice", why: "Every shift" }],
        },
      ],
    });

    expect(out.confirmationCandidates.map((row) => row.name)).not.toContain("Ward handovers");
  });

  it("keeps two skills that merely share a word", async () => {
    // The guard against the guard: "Wound dressing" and "Wound care" share a word but are
    // not the same skill, and collapsing them would silently drop real questions.
    mockOpenAICreate
      .mockResolvedValueOnce(claimsAsProven(["Wound dressing"]))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({
      roleCanon: [
        {
          ...MIXED_CANON[0],
          skills: [{ name: "Wound irrigation", category: "Clinical Procedures", why: "Routine" }],
        },
      ],
    });

    expect(out.confirmationCandidates.map((row) => row.name)).toContain("Wound irrigation");
  });
});

// ─── The second pass ───
//
// Someone finishes the skills section, adds Soldering, and comes back later from the edit
// flow to add more. It is the SAME endpoint and the same canon — which is the problem:
// nothing knew what was already on the CV, so the canon would cheerfully ask "This is
// standard for a Plumber. Did you do it?" about a skill sitting on their own CV, and spend
// the count re-listing skills they already had.
//
// Invisible while the confirmation list was five model-chosen rows. Guaranteed once the
// canon can fill it with twenty.
describe("a second pass knows what is already on the CV", () => {
  const ON_CV = ["Cannulation"];

  it("tells the generator, so the count is spent on what is missing", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    await run({ roleCanon: MIXED_CANON, existingSkills: ON_CV });
    const prompt = generationPrompt();

    expect(prompt).toMatch(/ALREADY ON THIS CV: Cannulation/);
    expect(prompt).toMatch(/spend the list on what is NOT there yet/);
  });

  it("never asks about a skill the user already has", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: MIXED_CANON, existingSkills: ON_CV });
    const asked = out.confirmationCandidates.map((row) => row.name);

    expect(asked).not.toContain("Cannulation");
    // …and still asks about the rest, so the second pass is worth running.
    expect(asked).toContain("Wound dressing");
  });

  it("blocks the model from asking about it either", async () => {
    // The canon top-up is not the only source of questions — the model's own candidates
    // must clear the same bar.
    mockOpenAICreate
      .mockResolvedValueOnce(
        skillsReply({
          suggestions: [],
          confirmationCandidates: [
            {
              name: "Cannulation",
              category: "Clinical Procedures",
              typicalFor: "exp0",
              reason: "Routine on most wards",
              question: "Did you cannulate?",
              evidence: [],
            },
          ],
        })
      )
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: MIXED_CANON, existingSkills: ON_CV });
    expect(out.confirmationCandidates.map((row) => row.name)).not.toContain("Cannulation");
  });

  it("does not ask about a near-duplicate of something on the CV", async () => {
    // "Ward handovers" beneath a "Handovers" the user added last week reads as a bug just
    // as loudly as an exact repeat.
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({
      roleCanon: [
        {
          ...MIXED_CANON[0],
          skills: [{ name: "Ward handovers", category: "Ward Practice", why: "Every shift" }],
        },
      ],
      existingSkills: ["Handovers"],
    });

    expect(out.confirmationCandidates.map((row) => row.name)).not.toContain("Ward handovers");
  });

  it("is unchanged on a first pass, when nothing is on the CV yet", async () => {
    mockOpenAICreate
      .mockResolvedValueOnce(skillsReply({ suggestions: [], confirmationCandidates: [] }))
      .mockResolvedValueOnce(categoriesReply());

    const out = await run({ roleCanon: MIXED_CANON });
    const asked = out.confirmationCandidates.map((row) => row.name);

    expect(generationPrompt()).not.toMatch(/ALREADY ON THIS CV/);
    expect(asked).toContain("Cannulation");
  });
});
