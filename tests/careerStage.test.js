// Career-stage-aware experience coaching. These test the PURE, exported helpers —
// `inferCareerStage`, `resolveCareerStage`, `experienceCoachingBlock` — so no AI
// round-trip is needed. `experienceCoachingBlock(stage)` returns the exact prompt
// fragment the model is given, so asserting on that string is a faithful proxy for
// "what the model is told to do" for each stage.
const aiService = require("../src/services/ai.service");

const { inferCareerStage, resolveCareerStage, experienceCoachingBlock } = aiService;

describe("career-stage inference (inferCareerStage)", () => {
  it("infers 'experienced' when the draft has a real job (title or company)", () => {
    expect(inferCareerStage({ experience: [{ title: "Wireline Operator" }] })).toBe("experienced");
    expect(inferCareerStage({ experience: [{ company: "Schlumberger" }] })).toBe("experienced");
  });

  it("infers 'grad' (entry-level) when there is only education/projects, or nothing", () => {
    expect(inferCareerStage({ experience: [], projects: [{ title: "Capstone" }] })).toBe("grad");
    expect(inferCareerStage({ education: [{ school: "UNILAG" }] })).toBe("grad");
    expect(inferCareerStage({})).toBe("grad");
    expect(inferCareerStage(undefined)).toBe("grad");
  });

  it("treats blank placeholder rows (no title AND no company) as NOT experience", () => {
    // The Studio seeds empty rows before /coach can write — those must not read as a job.
    expect(inferCareerStage({ experience: [{ _sortId: "s1", title: "", company: "" }] })).toBe(
      "grad"
    );
  });

  it("never infers 'changer' — it can't be read off CV shape", () => {
    expect(inferCareerStage({ experience: [{ title: "Analyst" }] })).not.toBe("changer");
    expect(inferCareerStage({})).not.toBe("changer");
  });
});

describe("career-stage resolution (resolveCareerStage)", () => {
  it("uses an explicit valid stage over the inference (frontend override)", () => {
    // A student adding their first part-time job: inference would say 'experienced',
    // but the explicit 'grad' chip must win so they aren't pushed for metrics.
    expect(
      resolveCareerStage({ stage: "grad", draft: { experience: [{ title: "Barista" }] } })
    ).toBe("grad");
    expect(resolveCareerStage({ stage: "changer", draft: {} })).toBe("changer");
    expect(resolveCareerStage({ stage: "experienced", draft: {} })).toBe("experienced");
  });

  it("falls back to inference when the stage is absent or invalid", () => {
    expect(resolveCareerStage({ draft: { experience: [{ title: "Nurse" }] } })).toBe("experienced");
    expect(resolveCareerStage({ stage: "nonsense", draft: {} })).toBe("grad");
    expect(resolveCareerStage({ stage: "", draft: { experience: [{ company: "PwC" }] } })).toBe(
      "experienced"
    );
    expect(resolveCareerStage()).toBe("grad");
  });

  // Several callers legitimately have no `stage` to send (askAria, projectIdeas, every
  // interview-prep entry point). Before this, they fell straight through to the CV-shape
  // guess and silently discarded what the user actually picked — which is why a career
  // changer could never be interviewed as one.
  it("uses the stage PERSISTED on the draft when the caller sends none", () => {
    expect(
      resolveCareerStage({ draft: { careerStage: "changer", experience: [{ title: "Teacher" }] } })
    ).toBe("changer");
    expect(
      resolveCareerStage({ draft: { careerStage: "grad", experience: [{ title: "Barista" }] } })
    ).toBe("grad");
  });

  it("prefers an explicit this-turn stage over the persisted one", () => {
    expect(resolveCareerStage({ stage: "experienced", draft: { careerStage: "grad" } })).toBe(
      "experienced"
    );
  });

  it("ignores a garbage persisted value and falls through to inference", () => {
    expect(
      resolveCareerStage({ draft: { careerStage: "wat", experience: [{ title: "Nurse" }] } })
    ).toBe("experienced");
    expect(resolveCareerStage({ draft: { careerStage: null, projects: [{ title: "Capstone" }] } }))
      .toBe("grad");
  });
});

// Lives here, NOT in interviewArchetypes.test.js: that suite asserts the archetype
// module stays engine-agnostic by checking ai.service is absent from require.cache,
// and requiring ai.service there would defeat it. The dependency is one-directional,
// so exercising the pair from this side is safe.
describe("career changers actually reach the changer evidence base", () => {
  // Regression guard for a real production defect: every interview-prep entry point
  // called inferCareerStage directly, and inference CANNOT return 'changer' (a pivot is
  // not readable off CV shape). So the changer evidence base — written, exported and
  // tested — was unreachable in production, and every career changer was interviewed as
  // 'experienced'. Prep now resolves the stage, which honours the persisted pick.
  const archetypes = require("../src/services/interviewArchetypes.service");
  const draft = { careerStage: "changer", experience: [{ title: "Secondary School Teacher" }] };

  it("resolves a persisted 'changer' pick into the changer archetype", () => {
    const stage = resolveCareerStage({ draft });
    expect(stage).toBe("changer");

    const archetype = archetypes.selectArchetype({ role: "HR Business Partner", stage });
    expect(archetype.stage).toBe("changer");
    expect(archetype.evidenceBase).toMatch(/changing fields/i);
    expect(archetype.evidenceBase).toMatch(/transferable/i);
  });

  it("documents what the old inference-only path did, so a revert fails loudly", () => {
    expect(inferCareerStage(draft)).toBe("experienced");
    expect(
      archetypes.selectArchetype({ role: "HR Business Partner", stage: inferCareerStage(draft) })
        .stage
    ).toBe("experienced");
  });
});

describe("experience coaching block — shared core rule (every stage)", () => {
  const stages = ["experienced", "grad", "changer"];

  it.each(stages)("'%s' keeps achievements-not-duties and bans invented numbers", (stage) => {
    const block = experienceCoachingBlock(stage);
    expect(block).toMatch(/ACHIEVEMENTS, not duties/i);
    expect(block).toMatch(/responsible for/i); // the anti-pattern it bans
    // Evidence, not numbers — and never fabricate one.
    expect(block).toMatch(/EVIDENCE/i);
    expect(block).toMatch(/NEVER invent/i);
  });

  it.each(stages)("'%s' carries the discovery-not-demand elicitation rule", (stage) => {
    const block = experienceCoachingBlock(stage);
    expect(block).toMatch(/ELICITATION/i);
    // The exact anti-pattern: a "done nothing" answer must NOT be met with a metric demand.
    expect(block).toMatch(/haven't really done anything/i);
    expect(block).toMatch(/discovery question/i);
  });
});

describe("experience coaching block — experienced stage", () => {
  const block = experienceCoachingBlock("experienced");

  it("keeps the metric-oriented XYZ framing", () => {
    expect(block).toMatch(/EXPERIENCED/);
    expect(block).toMatch(/XYZ|as measured by/i);
    expect(block).toMatch(/number STRENGTHENS/i);
  });

  it("still refuses invented figures (a number only when real)", () => {
    expect(block).toMatch(/when it's real/i);
    expect(block).toMatch(/NEVER invent/i);
  });
});

describe("experience coaching block — entry-level (grad) stage", () => {
  const block = experienceCoachingBlock("grad");

  it("NEVER pushes for a number — explicitly forbids demanding a metric", () => {
    expect(block).toMatch(/ENTRY-LEVEL/);
    expect(block).toMatch(/Do NOT demand a metric/i);
    // Impact framed as scope/scale, not a figure.
    expect(block).toMatch(/scope or scale/i);
  });

  it("offers project / coursework / leadership material (not job titles)", () => {
    expect(block).toMatch(/coursework/i);
    expect(block).toMatch(/project/i);
    expect(block).toMatch(/leadership|societ/i);
    expect(block).toMatch(/not from job titles/i);
  });

  it("steers the answer scaffolds AWAY from a revenue metric", () => {
    // The 'generic scaffold' fix: entry-level starters lead with project/coursework,
    // and the example is a non-numeric (scope/scale) bullet.
    expect(block).toMatch(/SCAFFOLDS/);
    expect(block).toMatch(/NOT "increased revenue/i);
    expect(block).toMatch(/SCOPE or SCALE/i);
  });

  it("offers NYSC/SIWES as legitimate material without imposing them as rules", () => {
    expect(block).toMatch(/NYSC|SIWES/);
    // Offered ("where it applies"), not mandated.
    expect(block).toMatch(/where it applies/i);
  });
});

describe("experience coaching block — career-changer stage", () => {
  const block = experienceCoachingBlock("changer");

  it("foregrounds transferable skills and relevance to the target role", () => {
    expect(block).toMatch(/CAREER CHANGER/);
    expect(block).toMatch(/TRANSFERABLE/i);
    expect(block).toMatch(/relevance to the target role/i);
    expect(block).toMatch(/not industry tenure/i);
  });
});

describe("experience coaching block — default", () => {
  it("defaults to the experienced block on an unknown stage", () => {
    expect(experienceCoachingBlock("wat")).toBe(experienceCoachingBlock("experienced"));
    expect(experienceCoachingBlock(undefined)).toBe(experienceCoachingBlock("experienced"));
  });
});
