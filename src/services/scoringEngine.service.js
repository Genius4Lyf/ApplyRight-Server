/**
 * Deterministic Scoring Engine
 *
 * Pure math — no AI calls. Takes structured extraction data and computes
 * a weighted fit score with full breakdown.
 *
 * Weights:
 *   Skills       40%
 *   Experience   25%
 *   Education    15%
 *   Seniority    10%
 *   Overall      10% (bonus for strong profiles)
 */

const { compareSkills } = require("./skillNormalizer.service");
const extractionService = require("./extraction.service");

// ─── Weight Configuration ───
const WEIGHTS = {
  skills: 0.40,
  experience: 0.25,
  education: 0.15,
  seniority: 0.10,
  overall: 0.10,
};

// ─── Seniority Levels (ordinal ranking) ───
const SENIORITY_RANK = {
  intern: 0,
  junior: 1,
  mid: 2,
  "mid-senior": 3,
  senior: 4,
  staff: 5,
  principal: 6,
  lead: 6,
  manager: 5,
  director: 7,
  vp: 8,
  "c-level": 9,
  cto: 9,
  ceo: 9,
};

/**
 * Score skills match (0-100)
 * Must-have skills weighted 2x compared to nice-to-have
 */
const scoreSkills = (candidateSkills, requiredSkills) => {
  if (!requiredSkills || requiredSkills.length === 0) return { score: 50, details: null };

  const comparison = compareSkills(
    candidateSkills.map((s) => (typeof s === "string" ? s : s.name)),
    requiredSkills
  );

  // Weighted scoring: must_have = 2 points, nice_to_have = 1 point
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const req of requiredSkills) {
    const weight = req.importance === "must_have" ? 2 : 1;
    totalWeight += weight;
    if (comparison.matched.find((m) => m.name.toLowerCase() === req.name?.toLowerCase() ||
        m.matchedWith?.toLowerCase() === req.name?.toLowerCase())) {
      earnedWeight += weight;
    }
  }

  // Re-check using normalized comparison
  earnedWeight = 0;
  for (const m of comparison.matched) {
    const reqEntry = requiredSkills.find(
      (r) => r.name?.toLowerCase() === m.name?.toLowerCase()
    );
    const weight = (reqEntry?.importance || m.importance) === "must_have" ? 2 : 1;
    earnedWeight += weight;
  }

  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 75;

  return {
    score: Math.min(100, score),
    details: comparison,
  };
};

/**
 * Compute "effective" years of experience with a recency decay so a 5-year-
 * old role doesn't count the same as recent work.
 *
 * decay(yearsAgo) = 0.9^yearsAgo, capped at 1.0 for current/recent roles.
 * So a role ending this year contributes 100%, a role ending 5 years ago
 * contributes ~59%, and 10 years ago ~35%.
 *
 * Returns the input candidateYears unchanged if per-role data is missing,
 * so older extractions (no endYear) keep prior behaviour.
 */
const computeEffectiveYears = (candidateYears, experienceList) => {
  if (!Array.isArray(experienceList) || experienceList.length === 0) return candidateYears;
  const currentYear = new Date().getFullYear();
  let effective = 0;
  let anyDated = false;
  for (const exp of experienceList) {
    const years = Number(exp?.years) || 0;
    if (years <= 0) continue;
    const endYear = exp?.isCurrent ? currentYear : Number(exp?.endYear);
    if (!endYear || isNaN(endYear)) {
      // No date — assume recent (no decay) so we don't underweight a role
      // we just can't place in time. Caller can still fall back to raw years.
      effective += years;
      continue;
    }
    anyDated = true;
    const yearsAgo = Math.max(0, currentYear - endYear);
    const decay = Math.pow(0.9, yearsAgo);
    effective += years * decay;
  }
  // If NO role had a parseable endYear, trust the legacy total instead of
  // collapsing recency-decay logic onto blank input.
  if (!anyDated) return candidateYears;
  return effective;
};

/**
 * Score experience match (0-100).
 * Optionally accepts per-role experience list to apply recency-weighting:
 * older roles count less than recent ones.
 */
const scoreExperience = (candidateYears, requiredYears, experienceList = null) => {
  const effectiveYears = computeEffectiveYears(candidateYears, experienceList);

  // No requirement stated → neutral default
  if (!requiredYears || requiredYears <= 0) {
    return {
      score: effectiveYears > 0 ? 60 : 40,
      match: true,
      feedback: "No specific experience requirement stated.",
      candidateYears,
      effectiveYears: Math.round(effectiveYears * 10) / 10,
    };
  }

  const ratio = effectiveYears / requiredYears;

  let score;
  let match;
  let feedback;

  // Round effective years to one decimal for human-friendly feedback.
  const effShown = Math.round(effectiveYears * 10) / 10;
  // If recency-decay is active, append a hint to feedback so the user knows
  // why a 6-year resume only counted as ~4 effective years.
  const decayNote = experienceList && Array.isArray(experienceList) && effectiveYears < candidateYears
    ? ` (recency-weighted from ${candidateYears} total)`
    : "";

  if (ratio >= 1.5) {
    score = 100;
    match = true;
    feedback = `Exceeds requirement: ${effShown} years vs ${requiredYears} required${decayNote}.`;
  } else if (ratio >= 1.0) {
    score = 90 + Math.round((ratio - 1.0) * 20);
    match = true;
    feedback = `Meets requirement: ${effShown} years vs ${requiredYears} required${decayNote}.`;
  } else if (ratio >= 0.75) {
    score = 70 + Math.round((ratio - 0.75) * 80);
    match = true;
    feedback = `Slightly below requirement: ${effShown} years vs ${requiredYears} required${decayNote}, but close enough to be competitive.`;
  } else if (ratio >= 0.5) {
    score = 40 + Math.round((ratio - 0.5) * 120);
    match = false;
    feedback = `Below requirement: ${effShown} years vs ${requiredYears} required${decayNote}. Candidate may need to highlight transferable experience.`;
  } else {
    score = Math.max(10, Math.round(ratio * 80));
    match = false;
    feedback = `Significantly below requirement: ${effShown} years vs ${requiredYears} required${decayNote}.`;
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    match,
    feedback,
    candidateYears,
    effectiveYears: effShown,
    requiredYears,
  };
};

/**
 * Score education match (0-100)
 */
const DEGREE_RANK = {
  none: 0,
  "high school": 1,
  diploma: 1,
  certificate: 1,
  associate: 2,
  "associate's": 2,
  bachelor: 3,
  "bachelor's": 3,
  bs: 3,
  ba: 3,
  bsc: 3,
  "b.s.": 3,
  "b.a.": 3,
  master: 4,
  "master's": 4,
  ms: 4,
  ma: 4,
  msc: 4,
  mba: 4,
  "m.s.": 4,
  "m.a.": 4,
  phd: 5,
  "ph.d.": 5,
  doctorate: 5,
  doctoral: 5,
  "d.sc.": 5,
};

const getDegreeRank = (degree) => {
  if (!degree) return 0;
  const lower = degree.toLowerCase().trim();
  // Direct match
  if (DEGREE_RANK[lower] !== undefined) return DEGREE_RANK[lower];
  // Partial match
  for (const [key, rank] of Object.entries(DEGREE_RANK)) {
    if (lower.includes(key)) return rank;
  }
  return 2; // Unknown degree → assume associate-level
};

const scoreEducation = (candidateEducation, requiredEducation) => {
  if (!requiredEducation || !requiredEducation.degree || requiredEducation.degree === "Unknown") {
    return {
      score: 55,
      match: true,
      feedback: "No specific education requirement stated.",
    };
  }

  const reqRank = getDegreeRank(requiredEducation.degree);
  const candidateRank = candidateEducation?.length
    ? Math.max(...candidateEducation.map((e) => getDegreeRank(e.degree)))
    : 0;

  // Field match bonus
  let fieldBonus = 0;
  if (requiredEducation.field && candidateEducation?.length) {
    const reqField = requiredEducation.field.toLowerCase();
    const hasFieldMatch = candidateEducation.some((e) => {
      const candField = (e.field || e.degree || "").toLowerCase();
      return (
        candField.includes(reqField) ||
        reqField.includes(candField) ||
        // Common equivalences
        (reqField.includes("computer science") &&
          (candField.includes("software") ||
            candField.includes("computing") ||
            candField.includes("information technology"))) ||
        (reqField.includes("engineering") && candField.includes("engineering"))
      );
    });
    if (hasFieldMatch) fieldBonus = 10;
  }

  let score;
  let match;
  let feedback;

  if (candidateRank >= reqRank) {
    score = 90 + fieldBonus;
    match = true;
    feedback = "Education requirement met.";
  } else if (candidateRank === reqRank - 1) {
    score = 65 + fieldBonus;
    match = false;
    feedback = "Education slightly below requirement. Strong experience may compensate.";
  } else {
    score = Math.max(20, 40 - (reqRank - candidateRank) * 15) + fieldBonus;
    match = false;
    feedback = "Education below requirement.";
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    match,
    feedback,
  };
};

/**
 * Score seniority alignment (0-100)
 */
const scoreSeniority = (candidateLevel, requiredLevel) => {
  if (!requiredLevel) {
    return {
      score: 55,
      match: true,
      candidateLevel: candidateLevel || "mid",
      requiredLevel: "not specified",
      feedback: "No specific seniority requirement.",
    };
  }

  const candRank = SENIORITY_RANK[candidateLevel?.toLowerCase()] ?? 2;
  const reqRank = SENIORITY_RANK[requiredLevel?.toLowerCase()] ?? 2;
  const diff = candRank - reqRank;

  let score;
  let match;
  let feedback;

  if (diff === 0) {
    score = 100;
    match = true;
    feedback = "Seniority level matches perfectly.";
  } else if (diff === 1) {
    score = 90;
    match = true;
    feedback = "Candidate is slightly above required seniority — strong fit.";
  } else if (diff === -1) {
    score = 70;
    match = true;
    feedback = "Candidate is slightly below required seniority but may be ready to step up.";
  } else if (diff >= 2) {
    score = 75;
    match = true;
    feedback = "Candidate exceeds seniority requirement — may be overqualified.";
  } else {
    score = Math.max(20, 50 + diff * 15);
    match = false;
    feedback = `Candidate seniority (${candidateLevel}) is below required (${requiredLevel}).`;
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    match,
    candidateLevel: candidateLevel || "mid",
    requiredLevel,
    feedback,
  };
};

/**
 * Compute overall profile strength bonus (0-100)
 * Rewards candidates with diverse, complete profiles
 */
const scoreOverall = (candidateData) => {
  let score = 50; // Baseline

  // Has summary/objective
  if (candidateData.summary && candidateData.summary.length > 50) score += 10;

  // Has projects
  if (candidateData.projects && candidateData.projects.length > 0) score += 10;

  // Has multiple experiences
  if (candidateData.experience && candidateData.experience.length >= 2) score += 10;

  // Has education
  if (candidateData.education && candidateData.education.length > 0) score += 10;

  // Has a good number of skills
  const skillCount = candidateData.skills?.length || 0;
  if (skillCount >= 5) score += 5;
  if (skillCount >= 10) score += 5;

  return { score: Math.min(100, score) };
};

/**
 * Main scoring function — computes the final fit score.
 *
 * @param {object} params
 * @param {object} params.candidateData - Structured extraction from resume
 * @param {object} params.jobData - Structured extraction from JD
 * @returns {object} Full scoring result with breakdown
 */
const computeFitScore = ({ candidateData, jobData }) => {
  // 1. Skills score
  const candidateSkillNames = (candidateData.skills || []).map((s) =>
    typeof s === "string" ? s : s.name
  );
  const requiredSkills = (jobData.requiredSkills || []).map((s) =>
    typeof s === "string" ? { name: s, importance: "must_have" } : s
  );
  const preferredSkills = (jobData.preferredSkills || []).map((s) =>
    typeof s === "string" ? { name: s, importance: "nice_to_have" } : s
  );
  const allRequiredSkills = [...requiredSkills, ...preferredSkills];

  const skillsResult = scoreSkills(candidateSkillNames, allRequiredSkills);

  // 2. Experience score (recency-weighted when per-role endYear is available)
  const experienceResult = scoreExperience(
    candidateData.totalYearsExperience || 0,
    jobData.requiredYearsExperience || 0,
    candidateData.experience
  );

  // 3. Education score
  const educationResult = scoreEducation(
    candidateData.education,
    jobData.requiredEducation
  );

  // 4. Seniority score
  const seniorityResult = scoreSeniority(
    candidateData.seniorityLevel,
    jobData.seniorityLevel
  );

  // 5. Overall profile score
  const overallResult = scoreOverall(candidateData);

  // 6. Domain mismatch detection
  // Compare the candidate's domain with the job's domain
  const experienceTitles = (candidateData.experience || []).map((e) => e.title || "");
  const candidateDomain = extractionService.detectCandidateDomain(candidateSkillNames, experienceTitles);
  const jobTitle = jobData.jobTitle || "";
  const jobDescription = jobData.jobDescription || "";
  const jobDomain = extractionService.detectDomain(jobTitle, jobDescription);

  let domainPenalty = 0;
  if (jobDomain.primary !== "general" && candidateDomain.primary !== "general") {
    // Check if the candidate has ANY overlap with the job's domain
    const candidateDomains = new Set(candidateDomain.all);
    const jobDomains = jobDomain.all;
    const hasOverlap = jobDomains.some((d) => candidateDomains.has(d));

    if (!hasOverlap) {
      // Complete domain mismatch — significant penalty
      domainPenalty = 25;
    }
  }

  // ─── Weighted final score ───
  let fitScore = Math.round(
    skillsResult.score * WEIGHTS.skills +
    experienceResult.score * WEIGHTS.experience +
    educationResult.score * WEIGHTS.education +
    seniorityResult.score * WEIGHTS.seniority +
    overallResult.score * WEIGHTS.overall
  );

  // Apply domain penalty
  if (domainPenalty > 0) {
    fitScore = Math.max(5, fitScore - domainPenalty);
  }

  // ─── Recommendation ───
  let recommendation;
  if (fitScore >= 85) {
    recommendation = "strong_match";
  } else if (fitScore >= 70) {
    recommendation = "good_match";
  } else if (fitScore >= 50) {
    recommendation = "potential_match";
  } else {
    recommendation = "weak_match";
  }

  // ─── Action Plan ───
  const actionPlan = generateActionPlan(skillsResult, experienceResult, educationResult, seniorityResult);

  return {
    fitScore: Math.min(100, Math.max(0, fitScore)),
    recommendation,
    scoreBreakdown: {
      skillsScore: skillsResult.score,
      experienceScore: experienceResult.score,
      educationScore: educationResult.score,
      seniorityScore: seniorityResult.score,
      overallScore: overallResult.score,
    },
    matchedSkills: (skillsResult.details?.matched || []).map((s) => ({
      name: s.name,
      importance: s.importance,
    })),
    missingSkills: (skillsResult.details?.missing || []).map((s) => ({
      name: s.name,
      importance: s.importance,
    })),
    experienceAnalysis: {
      candidateYears: experienceResult.candidateYears || 0,
      requiredYears: experienceResult.requiredYears || 0,
      match: experienceResult.match,
      feedback: experienceResult.feedback,
    },
    seniorityAnalysis: {
      candidateLevel: seniorityResult.candidateLevel,
      requiredLevel: seniorityResult.requiredLevel,
      match: seniorityResult.match,
      feedback: seniorityResult.feedback,
    },
    educationAnalysis: {
      match: educationResult.match,
      feedback: educationResult.feedback,
    },
    actionPlan,
  };
};

/**
 * Generate deterministic action plan from scoring gaps
 */
const generateActionPlan = (skills, experience, education, seniority) => {
  const plan = [];

  // Missing must-have skills
  const missingMustHave = (skills.details?.missing || []).filter(
    (s) => s.importance === "must_have"
  );
  if (missingMustHave.length > 0) {
    plan.push({
      task: `Add missing critical skills to your resume: ${missingMustHave.map((s) => s.name).join(", ")}`,
      importance: "must_have",
      category: "skills",
    });
  }

  // Missing nice-to-have skills
  const missingNice = (skills.details?.missing || []).filter(
    (s) => s.importance === "nice_to_have"
  );
  if (missingNice.length > 0) {
    plan.push({
      task: `Consider highlighting these preferred skills if you have them: ${missingNice.map((s) => s.name).join(", ")}`,
      importance: "nice_to_have",
      category: "skills",
    });
  }

  // Experience gap
  if (!experience.match && experience.requiredYears > 0) {
    plan.push({
      task: `Address experience gap: you have ${experience.candidateYears} years but ${experience.requiredYears} are required. Emphasize relevant projects, freelance work, or transferable experience.`,
      importance: "must_have",
      category: "experience",
    });
  }

  // Education gap
  if (!education.match) {
    plan.push({
      task: "Education may not fully meet requirements. Highlight certifications, bootcamps, or equivalent practical experience.",
      importance: "nice_to_have",
      category: "education",
    });
  }

  // Seniority gap
  if (!seniority.match) {
    plan.push({
      task: `Seniority gap: role requires ${seniority.requiredLevel} level. Highlight leadership, mentoring, or ownership experience to demonstrate readiness.`,
      importance: "nice_to_have",
      category: "seniority",
    });
  }

  // Positive reinforcement if strong
  if (skills.score >= 80 && experience.match) {
    plan.push({
      task: "Your profile is a strong match. Focus on tailoring your resume language to mirror the job description's keywords.",
      importance: "nice_to_have",
      category: "optimization",
    });
  }

  return plan;
};

module.exports = {
  computeFitScore,
  scoreSkills,
  scoreExperience,
  scoreEducation,
  scoreSeniority,
  WEIGHTS,
};
