// Archetypes: selection, stage-awareness, and the guarantee that the module has
// no engine coupling — that last one is what makes the typed-engine parity phase
// a wiring job instead of a rewrite.

describe("the archetype module is engine-agnostic", () => {
  // ⚠️ This test deliberately requires the module ALONE, with the realtime prompt
  // builder, express, mongoose and the AI clients all unmocked and unloaded. If
  // someone later imports ai.service (or anything realtime-shaped) from it, this
  // fails — which is the entire point.
  it("selects and reads an archetype without touching the prompt builder", () => {
    jest.isolateModules(() => {
      const a = require("../src/services/interviewArchetypes.service");
      const picked = a.selectArchetype({ role: "HR Manager", stage: "grad" });
      expect(picked.key).toBe("screening");
      expect(picked.arc.length).toBeGreaterThan(0);
      expect(picked.gradesOn.length).toBeGreaterThan(0);
      expect(picked.doesNotGradeOn.length).toBeGreaterThan(0);
      expect(picked.evidenceBase).toMatch(/NYSC/);
      // And it can render its own prompt text with no external help.
      expect(a.formatArchetypeForPrompt(picked)).toMatch(/ROUGHLY THE GROUND TO COVER/);
      expect(a.formatArchetypeForAssessment(picked)).toMatch(/DO NOT COUNT ANY OF THESE/);
      // Nothing realtime-shaped got pulled in as a side effect.
      const loaded = Object.keys(require.cache).join("|");
      expect(loaded).not.toMatch(/realtime\.service/);
      expect(loaded).not.toMatch(/ai\.service/);
    });
  });

  it("exposes definitions as plain data any engine can read", () => {
    const a = require("../src/services/interviewArchetypes.service");
    Object.values(a.ARCHETYPES).forEach((arch) => {
      expect(typeof arch.key).toBe("string");
      expect(Array.isArray(arch.arc)).toBe(true);
      expect(Array.isArray(arch.gradesOn)).toBe(true);
      expect(Array.isArray(arch.doesNotGradeOn)).toBe(true);
      expect(Array.isArray(arch.openers)).toBe(true);
    });
  });
});

const a = require("../src/services/interviewArchetypes.service");

describe("selection is f(role family, career stage), never f(job title)", () => {
  it("graduate + an HR-ish role selects Screening at graduate stage", () => {
    ["HR Manager", "Talent Partner", "Recruiter", "Head of People"].forEach((role) => {
      const picked = a.selectArchetype({ role, stage: "grad" });
      expect(picked.key).toBe("screening");
      expect(picked.stage).toBe("grad");
    });
  });

  it("graduate + a manager-ish role selects Behavioural at graduate stage", () => {
    // NOTE: NOT "Engineering Manager" — the inherited regex order puts "engineer" ahead of
    // "manager", so it classifies as technical and falls back. See the dedicated test below.
    ["Team Lead", "Product Owner", "Director of Design", "Head of Operations"].forEach((role) => {
      const picked = a.selectArchetype({ role, stage: "grad" });
      expect(picked.key).toBe("behavioural");
      expect(picked.stage).toBe("grad");
    });
  });

  it("falls back cleanly to generic for an unmatched role family", () => {
    ["Growth Ninja", "Brand Storyteller", "", "   ", null, undefined].forEach((role) => {
      expect(a.selectArchetype({ role, stage: "grad" })).toBeNull();
    });
  });

  it("has no archetype for technical yet, and says so by falling back", () => {
    // Shipping a wrong arc is worse than the generic room.
    expect(a.selectArchetype({ role: "Senior Data Engineer", stage: "grad" })).toBeNull();
  });

  it("treats an unknown stage as experienced rather than breaking", () => {
    expect(a.selectArchetype({ role: "HR", stage: "wat" }).stage).toBe("experienced");
    expect(a.selectArchetype({ role: "HR" }).stage).toBe("experienced");
  });

  it("keeps the legacy style mapping working off the same regexes", () => {
    expect(a.styleFromRole("HR Manager")).toBe("screening");
    expect(a.styleFromRole("Backend Engineer")).toBe("technical");
    expect(a.styleFromRole("Team Lead")).toBe("behavioral");
    expect(a.styleFromRole("Growth Ninja")).toBe("balanced");
  });
});

describe("stage changes the evidence base, never the temperature", () => {
  const grad = a.selectArchetype({ role: "HR", stage: "grad" });
  const exp = a.selectArchetype({ role: "HR", stage: "experienced" });

  it("swaps employment history for projects, societies and NYSC at graduate stage", () => {
    expect(grad.evidenceBase).toMatch(/projects/i);
    expect(grad.evidenceBase).toMatch(/NYSC/);
    expect(grad.evidenceBase).toMatch(/societies/i);
    expect(exp.evidenceBase).toMatch(/work history/i);
    expect(exp.evidenceBase).not.toMatch(/NYSC/);
  });

  it("does NOT soften the room for a graduate", () => {
    const text = a.formatArchetypeForPrompt(grad);
    expect(text).toMatch(/same pressure, same standards, same follow-ups/i);
    // No gentleness leaking in via the archetype.
    [/gentle/i, /encourag/i, /reassur/i, /go easy/i, /be kind/i, /nervous/i].forEach((re) =>
      expect(text).not.toMatch(re)
    );
  });

  it("grades on and excludes exactly the same things at both stages", () => {
    expect(grad.gradesOn).toEqual(exp.gradesOn);
    expect(grad.doesNotGradeOn).toEqual(exp.doesNotGradeOn);
  });

  it("frames graduate evidence as normal, not as a concession", () => {
    expect(grad.evidenceBase).toMatch(/normal place to look rather than a concession/i);
  });
});

describe("the two archetypes carry the right arcs", () => {
  it("Screening covers orient → intro → motivation → evidence → close", () => {
    const s = a.getArchetype("screening", "grad");
    expect(s.arc.join(" ")).toMatch(/orient/i);
    expect(s.arc.join(" ")).toMatch(/motivation/i);
    expect(s.arc.join(" ")).toMatch(/evidence/i);
    expect(s.gradesOn.join(" ")).toMatch(/we/); // pushing past "we" to "I"
    expect(s.doesNotGradeOn.join(" ")).toMatch(/seniority/i);
    expect(s.doesNotGradeOn.join(" ")).toMatch(/prestige/i);
    expect(s.doesNotGradeOn.join(" ")).toMatch(/polish/i);
  });

  it("Behavioural covers situational frame → others → setback → initiative → growth", () => {
    const b = a.getArchetype("behavioural", "grad");
    expect(b.arc.join(" ")).toMatch(/situational frame/i);
    expect(b.arc.join(" ")).toMatch(/friction/i);
    expect(b.arc.join(" ")).toMatch(/setback/i);
    expect(b.arc.join(" ")).toMatch(/nobody asked them to do/i);
    expect(b.gradesOn.join(" ")).toMatch(/situation, action and outcome/i);
    // The exclusion that matters most for a student.
    expect(b.doesNotGradeOn.join(" ")).toMatch(/group project beats a vague internship/i);
  });

  it("are skeletons, not running orders — no timings, no scripted questions", () => {
    Object.values(a.ARCHETYPES).forEach((arch) => {
      const text = a.formatArchetypeForPrompt({ ...arch, evidenceBase: "x" });
      expect(text).toMatch(/NOT a running order/i);
      expect(text).not.toMatch(/\d+\s*(min|minute|second)/i);
      expect(text).not.toMatch(/"/); // nothing recitable
    });
  });
});

describe("the assessment constraints protect a graduate at the last step", () => {
  it("states that having no employment history is not a weakness or a gap", () => {
    const text = a.formatArchetypeForAssessment(a.selectArchetype({ role: "HR", stage: "grad" }));
    expect(text).toMatch(/no employment history is NOT a weakness/i);
    expect(text).toMatch(/must NOT be mentioned as one/i);
    expect(text).toMatch(/never on where it came from/i);
  });

  it("does not add the graduate clause for an experienced candidate", () => {
    const text = a.formatArchetypeForAssessment(
      a.selectArchetype({ role: "HR", stage: "experienced" })
    );
    expect(text).not.toMatch(/no employment history/i);
  });

  it("always carries the does-not-grade-on exclusions", () => {
    ["grad", "experienced", "changer"].forEach((stage) => {
      const text = a.formatArchetypeForAssessment(a.selectArchetype({ role: "Team Lead", stage }));
      expect(text).toMatch(/DO NOT COUNT ANY OF THESE AGAINST THEM/);
      expect(text).toMatch(/group project beats a vague internship/i);
    });
  });

  it("renders nothing when there is no archetype", () => {
    expect(a.formatArchetypeForAssessment(null)).toBe("");
    expect(a.formatArchetypeForPrompt(null)).toBe("");
  });
});

describe("inherited role-family precedence (documented, not accidental)", () => {
  // styleFromRole has always tested the technical regex BEFORE the manager one,
  // so a title carrying both words lands on technical. Preserved exactly rather
  // than reordered: changing it would silently change which interview STYLE
  // existing users get, which is not this phase's job. The consequence here is
  // benign — it falls back to the generic room, it does not break.
  it("classifies mixed titles as technical, and falls back rather than misfiring", () => {
    ["Engineering Manager", "Data Manager", "Head of Engineering"].forEach((role) => {
      expect(a.roleFamily(role)).toBe("technical");
      expect(a.selectArchetype({ role, stage: "grad" })).toBeNull();
    });
  });
});
