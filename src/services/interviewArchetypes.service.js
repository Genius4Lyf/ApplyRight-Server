// Interview archetypes — WHAT an interview is trying to find out, as data.
//
// ⚠️ ENGINE-AGNOSTIC BY DESIGN. This module is plain data plus pure functions. It
// knows nothing about the realtime API, the prompt builder, Express, or Mongoose,
// and it must stay that way: the live voice engine consumes it today and the typed
// engine (conversationTurn) has to be able to consume the SAME definitions later.
// Bake any of this into the realtime prompt builder and that parity work stops
// being a wiring job and becomes a rewrite.
//
// SELECTION IS f(role family, career stage) — never f(job title). Job titles are
// unbounded ("Growth Ninja", "Head of Vibes"); role families are not.
//
// ⚠️ STAGE CHANGES THE EVIDENCE BASE, NEVER THE TEMPERATURE. A graduate's
// Behavioural interview runs on projects, societies, NYSC and side hustles instead
// of employment history — at exactly the same pressure. Interview nerves are
// universal, not a graduate condition, and the Phase 3 realism boundary is
// unchanged by stage. Nothing in this file may soften a room.
//
// No AI call: everything here is a lookup on cached data.

// ---------------------------------------------------------------------------
// ROLE FAMILY
// ---------------------------------------------------------------------------
// The SAME regexes the interview-style picker has always used (previously inline
// in ai.service as styleFromRole). Kept here as the single definition so the two
// notions of "what kind of role is this" cannot drift apart.
const ROLE_FAMILY_PATTERNS = [
  { family: "hr", re: /\bhr\b|human resources|talent|recruit|people\b/ },
  {
    family: "technical",
    re: /engineer|developer|programmer|technical|architect|data|scientist|devops|sre|security|qa/,
  },
  { family: "manager", re: /manager|lead|head|director|principal|chief|product|design|owner/ },
];

/** @returns {'hr'|'technical'|'manager'|null} null = unrecognised, caller falls back. */
const roleFamily = (role = "") => {
  const r = String(role || "").toLowerCase();
  if (!r.trim()) return null;
  const hit = ROLE_FAMILY_PATTERNS.find((p) => p.re.test(r));
  return hit ? hit.family : null;
};

/** The legacy interview-style label, derived from the same families. */
const FAMILY_TO_STYLE = { hr: "screening", technical: "technical", manager: "behavioral" };
const styleFromRole = (role = "") => FAMILY_TO_STYLE[roleFamily(role)] || "balanced";

// ---------------------------------------------------------------------------
// EVIDENCE BASE — what the arcs run ON, by career stage
// ---------------------------------------------------------------------------
// Stage keys mirror the CV coach's enum exactly ('grad' | 'experienced' |
// 'changer') — see inferCareerStage. Do not introduce a fourth notion of stage.
const EVIDENCE_BASE = {
  grad: "This candidate is at the START of their career, so their evidence lives in course and final-year projects, coursework, student societies, volunteering, NYSC, internships, industrial training and side hustles — not in employment history. Ask for examples from THERE as a matter of course, as the normal place to look rather than a concession. Do NOT keep asking for workplace examples they cannot have, and do not treat the absence of a job as a finding. Everything else about how you interview them is unchanged: same pressure, same standards, same follow-ups.",
  experienced:
    "This candidate has real work history, so run the arc on it — specific roles, decisions they personally owned, and what actually happened. Work outside the job title (side projects, mentoring, things they fixed unasked) counts too.",
  changer:
    "This candidate is changing fields. Their evidence spans both sides — transferable work from their previous field, plus projects, study or freelance work from the switch itself. Treat both as real, and expect them to connect it to this role.",
};

const evidenceBase = (stage) => EVIDENCE_BASE[stage] || EVIDENCE_BASE.experienced;

// ---------------------------------------------------------------------------
// THE ARCHETYPES
// ---------------------------------------------------------------------------
// A competency SKELETON, not a running order: areas in rough sequence, with no
// timings and no questions. Nothing here may be recitable — the Phase 4
// scripted-line audit runs over the assembled prompt and will catch it.
const ARCHETYPES = {
  screening: {
    key: "screening",
    label: "Screening interview",
    // What the candidate should be told this is (feeds the pre-call brief).
    brief:
      "A recruiter-style first round: who you are, why this role and this employer, and a walk through your evidence at a high level. Not a technical test.",
    lens: "You are running the SCREENING round — the recruiter's lens. What you are trying to establish is whether this person makes coherent sense for this role and actually wants it.",
    arc: [
      "open and orient them",
      "their self-introduction",
      "motivation for this role and this employer specifically",
      "a walk through their evidence",
      "their questions, and close",
    ],
    gradesOn: [
      "whether they can frame themselves coherently",
      "motivation that is specific to this role and employer rather than generic",
      "concrete evidence rather than claims",
      "ownership of what THEY personally did — candidates default to “we”, so push for the individual contribution",
    ],
    doesNotGradeOn: [
      "seniority",
      "the prestige of the employer, school or project in their example",
      "polish or how rehearsed they sound",
    ],
    // Openers that can still set a screening frame. All four work here — a
    // screening round can legitimately open from any direction.
    openers: ["self_intro", "cv_specific", "jd_requirement", "gap_bridge"],
  },

  behavioural: {
    key: "behavioural",
    label: "Behavioural interview",
    brief:
      "A competency round built on real situations — how you have actually handled work with others, setbacks and things you started yourself. Expect follow-ups on what YOU did.",
    lens: "You are running the BEHAVIOURAL round. Everything is anchored in things that actually happened: you are trying to establish how they behave, not what they believe about themselves.",
    arc: [
      "open in the situational frame — signal early that you want real examples, not general views",
      "working with others, and friction",
      "a setback or something that went wrong",
      "initiative — something nobody asked them to do",
      "what they took from it, and close",
    ],
    gradesOn: [
      "whether an answer carries situation, action and outcome — even loosely",
      "personal ownership of the action",
      "honest self-awareness, including about the parts that went badly",
      "concrete detail instead of adjectives",
    ],
    doesNotGradeOn: [
      "the scale of the example — a well-told group project beats a vague internship, and small is not weak",
      "how senior or formal the setting was",
    ],
    // ⚠️ A behavioural round must land in the situational frame from the first
    // question. Opening on a bare job requirement invites a hypothetical answer,
    // which is the one thing this archetype is trying not to collect.
    openers: ["self_intro", "cv_specific"],
  },
};

// role family → archetype. `technical` deliberately has NO archetype yet: a
// technical deep-dive needs its own arc (grading structure-of-thinking, not STAR)
// and shipping a wrong one is worse than falling back to today's generic room.
const FAMILY_TO_ARCHETYPE = {
  hr: "screening",
  manager: "behavioural",
};

/**
 * archetype = f(role family, career stage). Deterministic, cached-data only.
 *
 * @returns {object|null} null when the role family is unrecognised or has no
 *   archetype yet — the caller MUST fall back to today's generic behaviour so a
 *   user with an odd job title gets a normal interview, never a broken one.
 */
const selectArchetype = ({ role = "", stage = "" } = {}) => {
  const family = roleFamily(role);
  const key = FAMILY_TO_ARCHETYPE[family];
  if (!key) return null;
  const base = ARCHETYPES[key];
  return {
    ...base,
    stage: EVIDENCE_BASE[stage] ? stage : "experienced",
    evidenceBase: evidenceBase(stage),
  };
};

/** Look one up directly by key (the typed engine will want this too). */
const getArchetype = (key, stage) => {
  const base = ARCHETYPES[key];
  if (!base) return null;
  return {
    ...base,
    stage: EVIDENCE_BASE[stage] ? stage : "experienced",
    evidenceBase: evidenceBase(stage),
  };
};

/**
 * The archetype as a compact prompt block. Kept deliberately tight: it shares
 * attention with the grounding, realism and variation blocks, and none of them
 * may crowd out "follow the candidate's previous answer".
 *
 * Engine-neutral text — the same block suits the typed engine.
 */
const formatArchetypeForPrompt = (a) => {
  if (!a) return "";
  return `
${a.lens}
- ROUGHLY THE GROUND TO COVER (a skeleton, NOT a running order and NOT a script — no timings, and their answers still decide where you actually go): ${a.arc.join(" → ")}.
- WHAT YOU ARE ACTUALLY WEIGHING: ${a.gradesOn.join("; ")}.
- WHAT MUST NOT COUNT AGAINST THEM: ${a.doesNotGradeOn.join("; ")}.
- WHERE THEIR EVIDENCE LIVES: ${a.evidenceBase}
`;
};

/**
 * The grading constraints, for the debrief. Separate from the prompt block above
 * because the assessor needs the exclusions and not the arc.
 *
 * This is the step where stage-awareness is most easily undone: a room that
 * fairly ran on a graduate's project work, followed by a scorecard that marks
 * them down for having no employment history, is worse than no stage-awareness
 * at all — it is unfair AND it teaches them the wrong lesson.
 */
const formatArchetypeForAssessment = (a) => {
  if (!a) return "";
  const stageLine =
    a.stage === "grad"
      ? "This candidate is at the START of their career. Their evidence is expected to come from projects, coursework, societies, volunteering, NYSC, internships and side hustles. Having no employment history is NOT a weakness, NOT a gap, and must NOT be mentioned as one, in any dimension, in the summary, in gaps, or in next steps. Judge the example they gave on how well they told it, never on where it came from."
      : "";
  return `
THIS WAS A ${a.label.toUpperCase()}. Judge it as one: ${a.gradesOn.join("; ")}.
DO NOT COUNT ANY OF THESE AGAINST THEM — they are explicitly out of scope for this interview and must not lower any score or appear as a gap: ${a.doesNotGradeOn.join("; ")}.
${stageLine}`.trim();
};

module.exports = {
  ARCHETYPES,
  ROLE_FAMILY_PATTERNS,
  roleFamily,
  styleFromRole,
  selectArchetype,
  getArchetype,
  evidenceBase,
  formatArchetypeForPrompt,
  formatArchetypeForAssessment,
};
