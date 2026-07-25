const v = require("../src/services/interviewVariation.service");

process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
jest.mock("openai", () => jest.fn().mockImplementation(() => ({})));
const ai = require("../src/services/ai.service");

const application = {
  fitAnalysis: {
    missingSkills: [
      { name: "dbt", importance: "must_have" },
      { name: "Airflow", importance: "must_have" },
      { name: "Looker", importance: "nice_to_have" },
    ],
    matchedSkills: [
      { name: "SQL", importance: "must_have" },
      { name: "Python", importance: "must_have" },
    ],
  },
  interviewPrep: {
    panel: {
      seats: [
        { name: "Ada", role: "HR", focus: "motivation and culture fit" },
        { name: "Bola", role: "Data Engineer", focus: "pipeline design" },
      ],
    },
    skillsWithEvidence: [{ name: "stakeholder reporting" }],
  },
};
const draft = {
  targetJob: {
    aiKeywords: [
      { name: "data modelling", importance: "must_have" },
      { name: "SQL", importance: "must_have" }, // dupe — must not appear twice
    ],
  },
};

describe("competency pool — built from cached data, no AI call", () => {
  it("collects from fit analysis, panel focus, skills and JD keywords", () => {
    const pool = v.buildCompetencyPool({ application, draft });
    expect(pool).toEqual(expect.arrayContaining(["dbt", "Airflow", "SQL", "Python"]));
    expect(pool).toEqual(expect.arrayContaining(["pipeline design", "motivation and culture fit"]));
    expect(pool).toEqual(expect.arrayContaining(["data modelling", "stakeholder reporting"]));
  });

  it("deduplicates case-insensitively", () => {
    const pool = v.buildCompetencyPool({ application, draft });
    const lower = pool.map((p) => p.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it("puts must-haves ahead of nice-to-haves", () => {
    const pool = v.buildCompetencyPool({ application, draft });
    expect(pool.indexOf("dbt")).toBeLessThan(pool.indexOf("Looker"));
  });

  it("returns an empty pool rather than throwing on a bare record", () => {
    expect(v.buildCompetencyPool({})).toEqual([]);
    expect(v.buildCompetencyPool({ application: {}, draft: null })).toEqual([]);
  });
});

describe("three consecutive sessions for one role", () => {
  const pool = v.buildCompetencyPool({ application, draft });

  // Simulate the real loop: plan → run → append history → plan again.
  const runSessions = (n) => {
    let history = [];
    const runs = [];
    for (let i = 0; i < n; i += 1) {
      const plan = v.planSession({ pool, history });
      runs.push(plan);
      history = v.appendHistory(
        history,
        v.buildHistoryEntry({
          plan,
          archetype: "HR",
          questionsAsked: ["Tell me about yourself", "Walk me through the pipeline you built"],
          delivery: { answerCount: 5, medianTimeToFirstWordMs: 2000 },
          overallScore: 60 + i,
        })
      );
    }
    return { runs, history };
  };

  it("gives a different opener strategy each time", () => {
    const { runs } = runSessions(3);
    const openers = runs.map((r) => r.openerStrategy);
    expect(new Set(openers).size).toBe(3);
  });

  it("steers toward different competencies each time", () => {
    const { runs } = runSessions(3);
    const [a, b, c] = runs.map((r) => r.sampledCompetencies);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
    // Runs 1 and 2 draw from genuinely unseen areas.
    expect(a.some((x) => b.includes(x))).toBe(false);
  });

  it("tells later sessions what earlier ones already covered", () => {
    const { runs } = runSessions(3);
    expect(runs[0].previouslyCovered).toEqual([]); // first ever
    expect(runs[1].previouslyCovered.length).toBeGreaterThan(0);
    expect(runs[1].previouslyCovered).toEqual(expect.arrayContaining(runs[0].sampledCompetencies));
  });

  it("accumulates history and caps it at 10", () => {
    const { history } = runSessions(14);
    expect(history).toHaveLength(v.HISTORY_CAP);
    // The cap drops the OLDEST, keeping the most recent runs.
    expect(history[history.length - 1].overallScore).toBe(73);
  });

  it("keeps delivery and score so cross-session progress is possible later", () => {
    const { history } = runSessions(2);
    expect(history[0].delivery).toEqual({ answerCount: 5, medianTimeToFirstWordMs: 2000 });
    expect(history[0].overallScore).toBe(60);
  });

  it("stores gists, not transcripts", () => {
    const { history } = runSessions(1);
    expect(history[0].questionGists).toHaveLength(2);
    history[0].questionGists.forEach((g) => expect(g.length).toBeLessThanOrEqual(120));
    expect(history[0]).not.toHaveProperty("transcript");
  });
});

describe("pool exhaustion cycles rather than emptying", () => {
  const tiny = ["alpha", "beta"];

  it("still returns focus areas once everything has been covered", () => {
    let history = [];
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      const plan = v.planSession({ pool: tiny, history });
      expect(plan.sampledCompetencies.length).toBeGreaterThan(0); // never empty
      seen.push(plan.sampledCompetencies);
      history = v.appendHistory(history, v.buildHistoryEntry({ plan }));
    }
    expect(seen[4].length).toBeGreaterThan(0);
  });

  it("pairs a recycled competency with a rotating opener so it does not read as a repeat", () => {
    let history = [];
    const openers = [];
    for (let i = 0; i < 4; i += 1) {
      const plan = v.planSession({ pool: tiny, history });
      openers.push(plan.openerStrategy);
      history = v.appendHistory(history, v.buildHistoryEntry({ plan }));
    }
    expect(new Set(openers).size).toBe(4); // all four strategies used
  });

  it("flags when it has started recycling", () => {
    const history = [v.buildHistoryEntry({ plan: { sampledCompetencies: tiny } })];
    expect(v.planSession({ pool: tiny, history }).recycled).toBe(true);
    expect(v.planSession({ pool: tiny, history: [] }).recycled).toBe(false);
  });

  it("returns an empty sample (not a crash) when there is no pool at all", () => {
    expect(v.planSession({ pool: [], history: [] }).sampledCompetencies).toEqual([]);
    expect(v.planSession({}).openerStrategy).toBeTruthy();
  });
});

describe("opener rotation", () => {
  it("never repeats the previous session's opener", () => {
    let history = [];
    let last = null;
    for (let i = 0; i < 8; i += 1) {
      const plan = v.planSession({ pool: ["a", "b", "c"], history });
      expect(plan.openerStrategy).not.toBe(last);
      last = plan.openerStrategy;
      history = v.appendHistory(history, v.buildHistoryEntry({ plan }));
    }
  });

  it("describes intent and supplies no sentence to recite", () => {
    Object.values(v.OPENER_STRATEGIES).forEach((s) => {
      expect(s.intent.length).toBeGreaterThan(20);
      expect(s.intent).not.toMatch(/"/); // no quoted line
    });
  });
});

describe("the variation block in the assembled instructions", () => {
  const ctx = { summary: "S", experience: [{ role: "Analyst", company: "Paystack" }] };
  const build = (variation) =>
    ai.buildRealtimeInstructions(ctx, { jobTitle: "PM" }, [{ question: "Tell me about yourself" }], 10, {
      candidateName: "Daniel",
      timeOfDay: "morning",
      variation,
    });

  it("is absent entirely on a first-ever session", () => {
    const first = v.planSession({ pool: ["dbt", "SQL", "Python"], history: [] });
    const p = build(first);
    expect(p).not.toMatch(/ALREADY COVERED WITH THIS CANDIDATE/);
    expect(p).toMatch(/LEAN THIS SESSION TOWARD/);
    // No dangling header with nothing under it.
    expect(p).not.toMatch(/ALREADY COVERED[^\n]*\n\s*\n/);
  });

  it("renders nothing at all when no variation is passed (older callers)", () => {
    const p = build(null);
    expect(p).not.toMatch(/THIS SESSION'S SHAPE/);
    expect(p).not.toMatch(/LEAN THIS SESSION TOWARD/);
  });

  it("names previously covered areas on a later session", () => {
    const history = [v.buildHistoryEntry({ plan: { sampledCompetencies: ["dbt", "Airflow"] } })];
    const p = build(v.planSession({ pool: ["dbt", "Airflow", "SQL", "Python"], history }));
    expect(p).toMatch(/ALREADY COVERED WITH THIS CANDIDATE/);
    expect(p).toMatch(/dbt/);
    expect(p).toMatch(/from a different angle/);
  });

  it("explicitly protects universal staples so the model does not contort", () => {
    const p = build(v.planSession({ pool: ["SQL"], history: [] }));
    expect(p).toMatch(/NOT a rule against repeating questions/i);
    expect(p).toMatch(/introduce themselves/i);
  });

  it("does not become a running order — it steers, it never prescribes questions", () => {
    const p = build(v.planSession({ pool: ["SQL", "dbt", "Python"], history: [] }));
    expect(p).toMatch(/not a list to get through/i);
    expect(p).toMatch(/the candidate's answers still decide where you actually go/i);
    // And follow-the-answer is still the dominant instruction.
    expect(p).toMatch(/ABOVE ALL, the candidate's PREVIOUS ANSWER/);
  });

  it("stays short — it must not crowd out grounding, realism or panel blocks", () => {
    const plan = v.planSession({ pool: ["a", "b", "c", "d", "e"], history: [] });
    const withV = build(plan).length;
    const without = build(null).length;
    expect(withV - without).toBeLessThan(1200);
  });
});

describe("composing with the archetype (Phase 5)", () => {
  const arch = require("../src/services/interviewArchetypes.service");
  const behavioural = arch.getArchetype("behavioural", "grad");
  const screening = arch.getArchetype("screening", "grad");
  const pool = ["dbt", "SQL", "Python", "stakeholder reporting"];

  it("constrains opener rotation to strategies compatible with the archetype", () => {
    // A Behavioural round opened on a bare JD requirement invites a hypothetical,
    // which is exactly what the archetype exists to avoid.
    let history = [];
    for (let i = 0; i < 6; i += 1) {
      const plan = v.planSession({ pool, history, archetype: behavioural });
      expect(behavioural.openers).toContain(plan.openerStrategy);
      history = v.appendHistory(history, v.buildHistoryEntry({ plan }));
    }
  });

  it("still rotates within the constrained set", () => {
    let history = [];
    const openers = [];
    for (let i = 0; i < 4; i += 1) {
      const plan = v.planSession({ pool, history, archetype: behavioural });
      openers.push(plan.openerStrategy);
      history = v.appendHistory(history, v.buildHistoryEntry({ plan }));
    }
    expect(new Set(openers).size).toBe(behavioural.openers.length);
    // And never twice in a row.
    openers.forEach((o, i) => i > 0 && expect(o).not.toBe(openers[i - 1]));
  });

  it("keeps all four strategies available where the archetype allows them", () => {
    let history = [];
    const openers = [];
    for (let i = 0; i < 4; i += 1) {
      const plan = v.planSession({ pool, history, archetype: screening });
      openers.push(plan.openerStrategy);
      history = v.appendHistory(history, v.buildHistoryEntry({ plan }));
    }
    expect(new Set(openers).size).toBe(4);
  });

  it("samples against the archetype's arc rather than ignoring it", () => {
    const plan = v.planSession({ pool, history: [], archetype: behavioural });
    // The arc leads; the JD pool supplies specifics hung off it.
    expect(behavioural.arc).toEqual(expect.arrayContaining([plan.sampledCompetencies[0]]));
  });

  it("three runs still vary once the archetype is applied", () => {
    let history = [];
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const plan = v.planSession({ pool, history, archetype: behavioural });
      runs.push(plan);
      history = v.appendHistory(history, v.buildHistoryEntry({ plan }));
    }
    expect(runs[0].sampledCompetencies).not.toEqual(runs[1].sampledCompetencies);
    expect(runs[1].sampledCompetencies).not.toEqual(runs[2].sampledCompetencies);
    expect(new Set(runs.map((r) => r.openerStrategy)).size).toBeGreaterThan(1);
  });

  it("works exactly as before when there is no archetype (generic fallback)", () => {
    const plan = v.planSession({ pool, history: [], archetype: null });
    expect(v.STRATEGY_ORDER).toContain(plan.openerStrategy);
    expect(plan.sampledCompetencies.every((c) => pool.includes(c))).toBe(true);
  });
});

describe("combined archetype + variation block size", () => {
  const arch = require("../src/services/interviewArchetypes.service");
  const ctx = { summary: "S", experience: [{ role: "Analyst", company: "Paystack" }] };
  const build = (opts) =>
    ai.buildRealtimeInstructions(ctx, { jobTitle: "PM" }, [{ question: "Tell me about yourself" }], 10, {
      candidateName: "Daniel",
      timeOfDay: "morning",
      ...opts,
    });

  it("stays bounded so it cannot out-shout grounding and realism", () => {
    const archetype = arch.getArchetype("behavioural", "grad");
    const history = [v.buildHistoryEntry({ plan: { sampledCompetencies: ["dbt", "SQL"] } })];
    const plan = v.planSession({ pool: ["dbt", "SQL", "Python"], history, archetype });
    const combined = build({ archetype, variation: plan }).length - build({}).length;
    expect(combined).toBeLessThan(3000);
  });

  it("leaves follow-the-answer as the dominant instruction", () => {
    const p = build({
      archetype: arch.getArchetype("screening", "grad"),
      variation: v.planSession({ pool: ["SQL"], history: [] }),
    });
    expect(p).toMatch(/ABOVE ALL, the candidate's PREVIOUS ANSWER/);
    expect(p).toMatch(/warm in MANNER, neutral in CONTENT/); // realism intact
    expect(p).toMatch(/VERIFY, NEVER PROSECUTE/); // grounding intact
  });
});
