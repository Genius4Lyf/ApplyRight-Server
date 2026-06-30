/**
 * ATS Coach — deterministic helpers for the CV Builder coach panel.
 *
 * No AI calls here. These power:
 *   - computeATSReadiness: the free, live "CV Health" score (also reused by the
 *     resume-upload flow).
 *   - cvDataToCandidate: maps a DraftCV into the candidateData shape the
 *     deterministic scoring engine (computeFitScore) and recommendRoles expect.
 *   - detectRedFlags: the "what a recruiter would flag" checks for Deep Scan.
 *
 * Keep computeATSReadiness in sync with the browser port at
 * applyright-frontend/src/utils/cvHealth.js (same checks, live as the user types).
 */

/**
 * Compute a lightweight ATS readiness score from a CV draft.
 * Pure deterministic checks on completeness and quality.
 * Returns { score: 0-100, checks: [...], tips: [...] }.
 *
 * `extractedData` is accepted for call-site compatibility with the upload flow
 * but the score is derived entirely from the structured `draft`.
 */
const computeATSReadiness = (extractedData, draft) => {
  const checks = [];
  const tips = [];
  let totalPoints = 0;
  let earnedPoints = 0;

  // 1. Professional Summary (15 pts)
  totalPoints += 15;
  const summary = draft.professionalSummary || "";
  if (summary.length >= 100) {
    earnedPoints += 15;
    checks.push({ label: "Professional summary", passed: true });
  } else if (summary.length > 0) {
    earnedPoints += 8;
    checks.push({ label: "Professional summary", passed: false, detail: "Too short" });
    tips.push("Expand your professional summary to 3-4 sentences highlighting your key strengths and career goals.");
  } else {
    checks.push({ label: "Professional summary", passed: false, detail: "Missing" });
    tips.push("Add a professional summary — it's the first thing recruiters and ATS systems scan.");
  }

  // 2. Work Experience (25 pts)
  totalPoints += 25;
  const exp = draft.experience || [];
  if (exp.length >= 2) {
    earnedPoints += 10;
    checks.push({ label: "Work experience entries", passed: true, detail: `${exp.length} roles` });
  } else if (exp.length === 1) {
    earnedPoints += 5;
    checks.push({ label: "Work experience entries", passed: false, detail: "Only 1 role" });
    tips.push("Add more work experience if available — most ATS systems rank resumes with 2+ roles higher.");
  } else {
    checks.push({ label: "Work experience entries", passed: false, detail: "Missing" });
    tips.push("Add work experience to strengthen your resume.");
  }

  // Check bullet quality (action verbs, quantification)
  const allBullets = exp.flatMap((e) => (e.description || "").split("\n").filter((b) => b.trim()));
  const bulletsWithNumbers = allBullets.filter((b) => /\d+/.test(b));
  if (allBullets.length > 0) {
    const quantifiedRatio = bulletsWithNumbers.length / allBullets.length;
    if (quantifiedRatio >= 0.3) {
      earnedPoints += 15;
      checks.push({ label: "Quantified achievements", passed: true, detail: `${bulletsWithNumbers.length}/${allBullets.length} bullets include metrics` });
    } else if (quantifiedRatio > 0) {
      earnedPoints += 8;
      checks.push({ label: "Quantified achievements", passed: false, detail: `Only ${bulletsWithNumbers.length}/${allBullets.length} bullets include metrics` });
      tips.push("Add numbers and metrics to more bullet points (e.g., 'Increased sales by 25%' instead of 'Increased sales').");
    } else {
      checks.push({ label: "Quantified achievements", passed: false, detail: "No metrics found" });
      tips.push("Quantify your achievements with numbers, percentages, or dollar amounts to stand out in ATS screening.");
    }
  }

  // 3. Skills (20 pts)
  totalPoints += 20;
  const skills = draft.skills || [];
  if (skills.length >= 8) {
    earnedPoints += 20;
    checks.push({ label: "Skills listed", passed: true, detail: `${skills.length} skills` });
  } else if (skills.length >= 4) {
    earnedPoints += 12;
    checks.push({ label: "Skills listed", passed: false, detail: `${skills.length} skills — aim for 8+` });
    tips.push("Add more relevant skills. ATS systems match keywords from job descriptions against your skills section.");
  } else {
    earnedPoints += skills.length > 0 ? 5 : 0;
    checks.push({ label: "Skills listed", passed: false, detail: skills.length > 0 ? `Only ${skills.length} skills` : "Missing" });
    tips.push("Add a comprehensive skills section — this is critical for ATS keyword matching.");
  }

  // 4. Education (10 pts)
  totalPoints += 10;
  const edu = draft.education || [];
  if (edu.length > 0) {
    earnedPoints += 10;
    checks.push({ label: "Education", passed: true, detail: `${edu.length} entries` });
  } else {
    checks.push({ label: "Education", passed: false, detail: "Missing" });
    tips.push("Add your education details — many ATS systems filter by degree requirements.");
  }

  // 5. Contact Info (15 pts)
  totalPoints += 15;
  const info = draft.personalInfo || {};
  const hasName = !!info.fullName && info.fullName !== "Candidate";
  const hasEmail = !!info.email;
  const hasPhone = !!info.phone;
  const hasLinkedIn = !!info.linkedin;
  const contactScore = [hasName, hasEmail, hasPhone, hasLinkedIn].filter(Boolean).length;
  if (contactScore >= 3) {
    earnedPoints += 15;
    checks.push({ label: "Contact information", passed: true });
  } else if (contactScore >= 2) {
    earnedPoints += 10;
    checks.push({ label: "Contact information", passed: false, detail: "Incomplete" });
    tips.push("Add your phone number and LinkedIn URL — recruiters need multiple ways to reach you.");
  } else {
    earnedPoints += 5;
    checks.push({ label: "Contact information", passed: false, detail: "Minimal" });
    tips.push("Complete your contact details: full name, email, phone, and LinkedIn profile.");
  }

  // 6. Projects (15 pts — bonus but valuable)
  totalPoints += 15;
  const projects = draft.projects || [];
  if (projects.length > 0) {
    earnedPoints += 15;
    checks.push({ label: "Projects", passed: true, detail: `${projects.length} projects` });
  } else {
    checks.push({ label: "Projects", passed: false, detail: "None listed" });
    tips.push("Consider adding relevant projects to showcase practical skills and initiative.");
  }

  const score = Math.round((earnedPoints / totalPoints) * 100);

  return { score, checks, tips };
};

// ─── Helpers for cvDataToCandidate ───

const CURRENT_YEAR = () => new Date().getFullYear();

// Pull a 4-digit year out of a free-text date string ("Jan 2022", "2020", "Present").
const parseYear = (dateStr) => {
  const m = String(dateStr || "").match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
};

// Estimate duration (whole years, min 1 when a role clearly exists) from the
// free-text start/end dates the builder stores.
const estimateYears = (startDate, endDate, isCurrent) => {
  const start = parseYear(startDate);
  const end = isCurrent ? CURRENT_YEAR() : parseYear(endDate);
  if (start && end && end >= start) return Math.max(1, end - start);
  // We know a role exists but can't date it — count it as 1 year, not 0.
  return startDate || endDate || isCurrent ? 1 : 0;
};

// Naive seniority inference from the most recent title, falling back to total
// years. Returns a key the scoringEngine's SENIORITY_RANK understands.
const inferSeniority = (experience, totalYears) => {
  const recentTitle = (experience[0]?.title || experience[0]?.role || "").toLowerCase();
  if (/(chief|cto|ceo|vp|vice president)/.test(recentTitle)) return "director";
  if (/(director|head of)/.test(recentTitle)) return "director";
  if (/(manager|lead|principal|staff)/.test(recentTitle)) return "lead";
  if (/senior|sr\.?/.test(recentTitle)) return "senior";
  if (/(intern|trainee)/.test(recentTitle)) return "intern";
  if (/(junior|jr\.?|entry|graduate)/.test(recentTitle)) return "junior";
  if (totalYears >= 8) return "senior";
  if (totalYears >= 4) return "mid";
  if (totalYears >= 1) return "junior";
  return "entry";
};

/**
 * Map a DraftCV (the builder's structured state) into the candidateData shape
 * that computeFitScore and recommendRoles expect. No AI — we already have
 * structured data, so this is cheap and deterministic.
 */
const cvDataToCandidate = (draft = {}) => {
  const skills = (draft.skills || [])
    .map((s) => (typeof s === "string" ? s : s?.name))
    .filter(Boolean);

  const experience = (draft.experience || []).map((e) => {
    const years = estimateYears(e.startDate, e.endDate, e.isCurrent);
    return {
      title: e.title || "",
      role: e.title || "",
      company: e.company || "",
      startDate: e.startDate || "",
      endDate: e.endDate || "",
      isCurrent: !!e.isCurrent,
      years,
      endYear: e.isCurrent ? CURRENT_YEAR() : parseYear(e.endDate),
      description: e.description || "",
    };
  });

  const totalYearsExperience = experience.reduce((sum, e) => sum + (e.years || 0), 0);

  const education = (draft.education || []).map((e) => ({
    degree: e.degree || "",
    field: e.field || "",
    school: e.school || "",
  }));

  return {
    skills,
    totalYearsExperience,
    seniorityLevel: inferSeniority(experience, totalYearsExperience),
    summary: draft.professionalSummary || "",
    experience,
    projects: draft.projects || [],
    education,
  };
};

/**
 * Compact, trusted snapshot of the CV for the live AI coach prompt — the first
 * name to address the user by, plus a per-section gap summary derived from the
 * same rubric the CV Health uses. No AI; built server-side so the prompt never
 * trusts client input.
 */
const coachState = (draft = {}) => {
  const info = draft.personalInfo || {};
  const firstRaw = (info.fullName || "").trim().split(/\s+/)[0] || "";
  const firstName = firstRaw && firstRaw.toLowerCase() !== "candidate" ? firstRaw : "";

  const exp = draft.experience || [];
  const skills = (draft.skills || [])
    .map((s) => (typeof s === "string" ? s : s?.name))
    .filter(Boolean);
  const projects = draft.projects || [];
  const edu = draft.education || [];
  const summary = (draft.professionalSummary || "").trim();

  const bullets = exp.flatMap((e) =>
    (e.description || "").split("\n").map((b) => b.trim()).filter(Boolean)
  );
  const quantified = bullets.filter((b) => /\d/.test(b)).length;
  const rolesWithEnoughBullets = exp.filter(
    (e) => (e.description || "").split("\n").filter((b) => b.trim()).length >= 2
  ).length;

  const contactMissing = [];
  if (!firstName) contactMissing.push("full name");
  if (!info.email) contactMissing.push("email");
  if (!info.phone) contactMissing.push("phone");
  if (!info.linkedin) contactMissing.push("LinkedIn URL");

  return {
    firstName,
    targetTitle: (draft.targetJob?.title || "").trim(),
    // The target job's description — read on the Target Job step to pull key
    // takeaways, and north-star context on the content steps. Truncated to keep the
    // prompt cheap.
    targetDescription: (draft.targetJob?.description || "").trim().slice(0, 1200),
    contact: { present: 4 - contactMissing.length, missing: contactMissing },
    summary: { chars: summary.length, ok: summary.length >= 100 },
    workHistory: {
      roles: exp.length,
      rolesWithEnoughBullets,
      bullets: bullets.length,
      quantified,
      quantifiedRatio: bullets.length ? Math.round((quantified / bullets.length) * 100) / 100 : 0,
    },
    skills: { count: skills.length },
    education: { count: edu.length },
    projects: { count: projects.length },
  };
};

// ─── Recruiter red-flags (deterministic) ───

// Bullet openers that read as passive/duty-listing rather than achievement.
const WEAK_OPENERS = [
  "responsible for",
  "worked on",
  "helped",
  "assisted",
  "duties included",
  "tasked with",
  "in charge of",
  "involved in",
];

// Empty filler recruiters routinely discount.
const BUZZWORDS = [
  "team player",
  "hard worker",
  "go-getter",
  "synergy",
  "think outside the box",
  "detail-oriented",
  "self-starter",
  "results-driven",
  "fast learner",
];

/**
 * Detect resume issues a recruiter would flag — deterministic only (no AI).
 * Returns an array of { label, detail, severity: "high"|"medium"|"low", affected }
 * where `affected` is [{ section: "experience"|"project", sortId, title }] for the
 * role/project entries that triggered a per-entry flag (empty for CV-wide flags).
 * The coach panel uses `affected` to offer a "Rewrite this role" fix on each finding.
 */
const detectRedFlags = (draft = {}) => {
  const flags = [];
  const exp = draft.experience || [];
  const projects = draft.projects || [];

  // Per-entry view so a flag can point at the exact role/project it came from.
  // Keyed by the stable _sortId the builder assigns (survives reorder/delete).
  const entries = [
    ...exp.map((e) => ({ section: "experience", sortId: e._sortId, title: e.title || "A role", entry: e })),
    ...projects.map((p) => ({ section: "project", sortId: p._sortId, title: p.title || "A project", entry: p })),
  ].map((x) => ({
    ...x,
    bullets: (x.entry.description || "").split("\n").map((b) => b.trim()).filter(Boolean),
  }));

  // Strip an entry down to the { section, sortId, title } the UI needs.
  const ref = ({ section, sortId, title }) => ({ section, sortId, title });

  const allBullets = entries.flatMap((x) => x.bullets);
  const bulletText = allBullets.join("\n").toLowerCase();

  // 1. Weak / passive bullet openers
  const isWeak = (b) => {
    const lower = b.replace(/^[•\-*\s]+/, "").toLowerCase();
    return WEAK_OPENERS.some((w) => lower.startsWith(w));
  };
  const weakHits = allBullets.filter(isWeak);
  if (weakHits.length > 0) {
    flags.push({
      label: "Passive bullet openers",
      detail: `${weakHits.length} bullet${weakHits.length > 1 ? "s" : ""} start with phrases like "Responsible for" or "Helped". Lead with a strong action verb (Led, Built, Delivered) instead.`,
      severity: weakHits.length >= 3 ? "high" : "medium",
      affected: entries.filter((x) => x.bullets.some(isWeak)).map(ref),
    });
  }

  // 2. Unquantified achievements
  if (allBullets.length > 0) {
    const quantified = allBullets.filter((b) => /\d/.test(b)).length;
    const ratio = quantified / allBullets.length;
    if (ratio < 0.3) {
      flags.push({
        label: "Few quantified results",
        detail: `Only ${quantified}/${allBullets.length} bullets include a number. Recruiters scan for measurable impact — add metrics (%, ₦, time saved, volume).`,
        severity: ratio === 0 ? "high" : "medium",
        // Target the entries that have bullets but no numbers at all.
        affected: entries
          .filter((x) => x.bullets.length > 0 && !x.bullets.some((b) => /\d/.test(b)))
          .map(ref),
      });
    }
  }

  // 3. Buzzwords / filler
  const foundBuzz = BUZZWORDS.filter((w) => bulletText.includes(w) || (draft.professionalSummary || "").toLowerCase().includes(w));
  if (foundBuzz.length > 0) {
    flags.push({
      label: "Generic buzzwords",
      detail: `Phrases like "${foundBuzz.slice(0, 3).join('", "')}" add no signal. Replace them with concrete evidence of the trait.`,
      severity: "low",
      affected: entries
        .filter((x) => foundBuzz.some((w) => x.bullets.join("\n").toLowerCase().includes(w)))
        .map(ref),
    });
  }

  // 4. First-person pronouns in bullets (resume convention is implied subject)
  const hasPronoun = (b) => /\b(i|my|me)\b/i.test(b.replace(/^[•\-*\s]+/, ""));
  const pronounHits = allBullets.filter(hasPronoun);
  if (pronounHits.length > 1) {
    flags.push({
      label: "First-person pronouns",
      detail: `${pronounHits.length} bullets use "I" / "my". Resume bullets conventionally drop the pronoun (e.g. "Led a team" not "I led a team").`,
      severity: "low",
      affected: entries.filter((x) => x.bullets.some(hasPronoun)).map(ref),
    });
  }

  // 5. Over-stuffed roles (too many bullets dilute impact)
  const stuffed = entries.filter((x) => x.section === "experience" && x.bullets.length > 8);
  if (stuffed.length > 0) {
    flags.push({
      label: "Over-stuffed role",
      detail: `"${stuffed[0].title}" has 9+ bullets. Recruiters skim — keep the 4-6 strongest per role.`,
      severity: "low",
      affected: stuffed.map(ref),
    });
  }

  // 6. Employment gaps (>1 year between consecutive dated roles)
  const dated = exp
    .map((e) => ({ start: parseYear(e.startDate), end: e.isCurrent ? CURRENT_YEAR() : parseYear(e.endDate) }))
    .filter((e) => e.start && e.end)
    .sort((a, b) => b.end - a.end); // most recent first
  for (let i = 0; i < dated.length - 1; i++) {
    const gap = dated[i].start - dated[i + 1].end;
    if (gap > 1) {
      flags.push({
        label: "Employment gap",
        detail: `There's roughly a ${gap}-year gap in your timeline. It's fine to have one — be ready to explain it, or fill it with study/freelance/volunteer work.`,
        severity: "low",
        affected: [],
      });
      break; // one gap flag is enough
    }
  }

  // 7. Unfilled placeholders left from AI bullet suggestions (e.g. "[X]%", "[N]").
  //    Applying ATS bullets without replacing these is a real credibility hit —
  //    the History suggestions modal already warns users to swap them for real
  //    numbers, so catch the ones that slipped through.
  const PLACEHOLDER = /\[(?:x|n|number|amount|value|metric|\$|%|\d{1,3})\]/i;
  const placeholderHits = allBullets.filter((b) => PLACEHOLDER.test(b));
  if (placeholderHits.length > 0) {
    flags.push({
      label: "Unfilled placeholders",
      detail: `${placeholderHits.length} bullet${placeholderHits.length > 1 ? "s" : ""} still contain placeholders like "[X]%" or "[N]". Replace them with your real numbers before applying — recruiters and ATS notice.`,
      severity: "high",
      affected: entries.filter((x) => x.bullets.some((b) => PLACEHOLDER.test(b))).map(ref),
    });
  }

  // 8. Page markers / parsing artifacts (e.g. "-- 1 of 3 --", "Page 1 of 3") left
  //    after pasting from a PDF export — noise that confuses ATS parsers.
  const PAGE_MARKER = /--+\s*\d+\s+of\s+\d+\s*--+|\bpage\s+\d+\s+of\s+\d+\b/i;
  const summaryText = draft.professionalSummary || "";
  if (allBullets.some((b) => PAGE_MARKER.test(b)) || PAGE_MARKER.test(summaryText)) {
    flags.push({
      label: "Page markers in your text",
      detail: `Text like "1 of 3" or "Page 2 of 3" looks pasted from a PDF. Remove these — they clutter the CV and confuse ATS parsers.`,
      severity: "medium",
      affected: entries.filter((x) => x.bullets.some((b) => PAGE_MARKER.test(b))).map(ref),
    });
  }

  // 9. Duplicate skills (case-insensitive) — pad the list and read careless.
  const skillNames = (draft.skills || [])
    .map((s) => (typeof s === "string" ? s : s?.name))
    .filter(Boolean);
  const seenSkill = new Set();
  const dupSkills = [];
  for (const n of skillNames) {
    const key = n.trim().toLowerCase();
    if (seenSkill.has(key)) {
      if (!dupSkills.some((d) => d.toLowerCase() === key)) dupSkills.push(n);
    } else {
      seenSkill.add(key);
    }
  }
  if (dupSkills.length > 0) {
    flags.push({
      label: "Duplicate skills",
      detail: `"${dupSkills.slice(0, 3).join('", "')}" appear${dupSkills.length === 1 ? "s" : ""} more than once in your skills. Remove the repeats — a tight, deduped list reads stronger.`,
      severity: "low",
      affected: [],
    });
  }

  return flags;
};

module.exports = {
  computeATSReadiness,
  cvDataToCandidate,
  detectRedFlags,
  coachState,
};
