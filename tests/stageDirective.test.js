// The stage fork shared by every WRITER (bullets, rewrite, skills) — as opposed to
// experienceCoachingBlock, which forks the INTERVIEW. Pure string builder, so asserting
// on the output is a faithful proxy for what the model is told, with no AI round-trip.
//
// The gap this closes: Aria interviewed a student gently (no metric pressure, projects
// treated as real evidence) and then handed the transcript to writers that had never
// heard of career stage.
const { stageDirective } = require("../src/services/ai.service");

const STAGES = ["experienced", "grad", "changer"];
const SECTIONS = ["experience", "project", "skills", "rewrite"];

describe("stageDirective — shape and safe defaults", () => {
  it("returns a non-empty block for every stage × section", () => {
    STAGES.forEach((stage) =>
      SECTIONS.forEach((section) => {
        const block = stageDirective(stage, section);
        expect(typeof block).toBe("string");
        expect(block.length).toBeGreaterThan(80);
        expect(block).toMatch(/CANDIDATE STAGE/);
        expect(block).toMatch(/WHAT COUNTS AS EVIDENCE/);
        expect(block).toMatch(/AUTHORITY CEILING/);
      })
    );
  });

  // Callers that don't resolve a stage must behave EXACTLY as they did before this
  // existed — an empty fragment, not a silent default to some stage's rules.
  it("returns '' for an absent or unknown stage", () => {
    expect(stageDirective(null, "experience")).toBe("");
    expect(stageDirective(undefined, "experience")).toBe("");
    expect(stageDirective("", "experience")).toBe("");
    expect(stageDirective("wat", "experience")).toBe("");
  });

  it("defaults to the experience section note", () => {
    expect(stageDirective("grad")).toBe(stageDirective("grad", "experience"));
  });
});

describe("stageDirective — grad never pressures for a metric", () => {
  it.each(SECTIONS)("'%s' frames impact as scope/scale rather than a number", (section) => {
    const block = stageDirective("grad", section);
    expect(block).toMatch(/do NOT reach for a business metric/i);
    expect(block).toMatch(/SCOPE, SCALE, AUDIENCE or FREQUENCY/i);
    expect(block).toMatch(/ONLY if they gave one outright/i);
  });

  it("treats coursework and projects as the normal place to look, not a concession", () => {
    const block = stageDirective("grad", "experience");
    expect(block).toMatch(/coursework/i);
    expect(block).toMatch(/capstone|academic/i);
    expect(block).toMatch(/NORMAL place to look, not as a concession/i);
  });

  it("caps authority at execution level — no invented ownership", () => {
    const block = stageDirective("grad", "experience");
    expect(block).toMatch(/EXECUTION LEVEL/);
    expect(block).toMatch(/must NOT claim strategic ownership/i);
  });

  // The single most important assertion in this file: no stage's block may itself
  // suggest a metric-shaped bullet to someone at the start of their career.
  it.each(SECTIONS)("'%s' contains no metric-shaped example", (section) => {
    const block = stageDirective("grad", section);
    expect(block).not.toMatch(/increased revenue/i);
    expect(block).not.toMatch(/\bby\s+\d+\s?%/i);
  });
});

describe("stageDirective — experienced", () => {
  const block = stageDirective("experienced", "experience");

  it("uses a real figure where given and falls back to scope where not", () => {
    expect(block).toMatch(/ESTABLISHED PROFESSIONAL/i);
    expect(block).toMatch(/STRENGTHENS a bullet/i);
    expect(block).toMatch(/scope, scale or frequency/i);
  });

  it("still refuses an invented figure", () => {
    expect(block).toMatch(/Never invent one to fill the shape/i);
  });

  it("keeps authority tied to the role actually held", () => {
    expect(block).toMatch(/Do not promote them a level/i);
  });
});

describe("stageDirective — changer", () => {
  const block = stageDirective("changer", "experience");

  it("treats both sides of the pivot as real evidence", () => {
    expect(block).toMatch(/CHANGING FIELDS/i);
    expect(block).toMatch(/transferable achievements/i);
    expect(block).toMatch(/certifications, freelance or personal projects/i);
  });

  // The rule that keeps a transferable claim honest: reframe the noun, never the verb.
  it("permits translating the domain noun but not the verb or the facts", () => {
    expect(block).toMatch(/BRIDGE/);
    expect(block).toMatch(/changing the DOMAIN NOUN, never the verb or the facts/i);
    expect(block).toMatch(/never from implied industry tenure/i);
  });

  it("is the only stage carrying the bridge rule", () => {
    expect(stageDirective("grad", "experience")).not.toMatch(/BRIDGE:/);
    expect(stageDirective("experienced", "experience")).not.toMatch(/BRIDGE:/);
  });
});

describe("stageDirective — reconciling with the TARGET JOB's seniority", () => {
  // briefContextBlock injects the JOB's seniority into the same prompt. Told to "match
  // senior scope" while being entry-level, a model resolves the contradiction by
  // inflating — the exact fabrication everything else in this pipeline guards against.
  it("names the conflict when a grad targets a senior posting", () => {
    const block = stageDirective("grad", "experience", { seniority: "senior" });
    expect(block).toMatch(/CONFLICT NOTICE/);
    expect(block).toMatch(/That gap is REAL and must not be papered over/i);
    expect(block).toMatch(/Aim the VOCABULARY at the job/i);
  });

  it.each(["lead", "manager", "director", "executive"])(
    "fires for '%s' too",
    (seniority) => {
      expect(stageDirective("grad", "experience", { seniority })).toMatch(/CONFLICT NOTICE/);
    }
  );

  it("stays silent when there is no conflict to reconcile", () => {
    expect(stageDirective("grad", "experience", { seniority: "entry" })).not.toMatch(
      /CONFLICT NOTICE/
    );
    expect(stageDirective("grad", "experience", { seniority: "" })).not.toMatch(/CONFLICT NOTICE/);
    expect(stageDirective("grad", "experience")).not.toMatch(/CONFLICT NOTICE/);
    // An experienced candidate targeting a senior role is not a contradiction.
    expect(stageDirective("experienced", "experience", { seniority: "senior" })).not.toMatch(
      /CONFLICT NOTICE/
    );
  });

  it("is case-insensitive about the seniority label", () => {
    expect(stageDirective("grad", "experience", { seniority: "Senior" })).toMatch(
      /CONFLICT NOTICE/
    );
  });
});

describe("stageDirective — section notes", () => {
  it("tells the project section that a project is not a job", () => {
    const block = stageDirective("grad", "project");
    expect(block).toMatch(/SECTION NOTE — PROJECTS/);
    expect(block).toMatch(/a project is not a job/i);
    // Must NOT carry the experience block's opening claim.
    expect(block).not.toMatch(/THIS IS A JOB/);
  });

  it("tells the skills section to rank on centrality and recency", () => {
    const block = stageDirective("experienced", "skills");
    expect(block).toMatch(/SECTION NOTE — SKILLS/);
    expect(block).toMatch(/proven only by coursework .* not a headline strength/i);
  });

  it("tells the rewrite that the stage constrains claims, never licenses new facts", () => {
    const block = stageDirective("changer", "rewrite");
    expect(block).toMatch(/SECTION NOTE — REWRITE/);
    expect(block).toMatch(/never licenses importing a fact the original did not contain/i);
  });

  it("adds no section note for plain experience", () => {
    expect(stageDirective("grad", "experience")).not.toMatch(/SECTION NOTE/);
  });
});
