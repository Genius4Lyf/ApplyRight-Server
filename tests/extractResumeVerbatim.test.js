// extractResumeProfile has two modes, and the difference between them is a PRODUCT
// decision, not a tuning knob — so it is pinned here rather than left to a prompt someone
// tidies later.
//
//  - DEFAULT: Aria polishes on the way in. This is the CV builder's paid upload
//    (/resumes/upload-and-create), which hands back a finished CV.
//  - VERBATIM: the user's own words survive intact. This is the Aria Studio import
//    (/studio/upload-import), where the whole session is Aria improving the CV WITH the
//    user. A silent rewrite there costs them twice: they never see their own CV, and the
//    coaching that follows has nothing left to improve.
//
// The summary rule matters just as much. In verbatim mode an ABSENT summary must come
// back absent, because the Studio's completeness gate reads it: fabricating one would
// unlock the editor on a CV that has no summary at all.
process.env.OPENAI_API_KEY = "k-openai";
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const mockOpenAICreate = jest.fn();
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockOpenAICreate } } }))
);
jest.mock("../src/models/AICallLog", () => ({ create: jest.fn().mockResolvedValue({}) }));

const ai = require("../src/services/ai.service");

const RESUME = "Ernest Akibor\nField Operator, Baker Hughes\n- Responsible for the wireline unit";

// The system prompt the model was actually handed on the last call.
const systemPrompt = () => mockOpenAICreate.mock.calls.at(-1)[0].messages[0].content;

beforeEach(() => {
  jest.clearAllMocks();
  mockOpenAICreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ experience: [], skills: [] }) } }],
    usage: {},
  });
});

describe("extractResumeProfile — verbatim vs polished", () => {
  it("tells the model to COPY the bullets when verbatim", async () => {
    await ai.extractResumeProfile(RESUME, {}, { verbatim: true });

    const system = systemPrompt();
    expect(system).toMatch(/copy the bullet points EXACTLY/i);
    expect(system).toMatch(/Do NOT rewrite/i);
    // The instruction that would undo the whole mode must be gone, not merely outranked.
    expect(system).not.toMatch(/REWRITE the original content/i);
  });

  it("returns an absent summary as absent when verbatim", async () => {
    await ai.extractResumeProfile(RESUME, {}, { verbatim: true });

    const system = systemPrompt();
    expect(system).toMatch(/copy the resume's existing summary/i);
    expect(system).toMatch(/return an empty string/i);
    expect(system).not.toMatch(/Generate a PROFESSIONAL SUMMARY/i);
  });

  it("carries the verbatim rule to projects too, not just experience", async () => {
    // Projects are bullets like any other. Leaving them out would silently rewrite half
    // a student's CV, which is exactly the half a student CV leans on.
    await ai.extractResumeProfile(RESUME, {}, { verbatim: true });

    expect(systemPrompt()).toMatch(/Copy each project's bullets VERBATIM/i);
  });

  it("still polishes by default — the CV builder's upload is unchanged", async () => {
    await ai.extractResumeProfile(RESUME, {});

    const system = systemPrompt();
    expect(system).toMatch(/REWRITE the original content into strong, achievement-oriented/i);
    expect(system).toMatch(/Generate a PROFESSIONAL SUMMARY/i);
    expect(system).not.toMatch(/copy the bullet points EXACTLY/i);
    expect(system).not.toMatch(/VERBATIM/i);
  });
});
