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
    expect(prompt).toMatch(/\[ie0\]/);
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
