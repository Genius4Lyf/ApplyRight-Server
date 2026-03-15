/**
 * CV Optimizer Service
 *
 * Production-grade pipeline for generating optimized CVs.
 *
 * Stage 1: Extract candidate profile (reuses existing extractors)
 * Stage 2: Relevance-score each experience/project (deterministic)
 * Stage 3: One AI call with structured output (moderate hallucination rules)
 * Stage 4: Keyword gap-fill (deterministic)
 * Stage 5: Assemble into DraftCV schema (deterministic)
 */

const { normalizeSkill, normalizeSkills } = require("./skillNormalizer.service");

// ─── Stage 2: Relevance Scoring ───

/**
 * Score how relevant an experience entry is to the target job.
 * Returns 0-100. Uses keyword overlap + title similarity + recency.
 *
 * @param {object} entry - { role, company, description, startDate, endDate }
 * @param {object} jobData - { requiredSkills, preferredSkills, detectedJobTitle, ... }
 * @returns {number} relevance score 0-100
 */
const scoreRelevance = (entry, jobData) => {
  let score = 0;

  const entryText = [
    entry.role || entry.title || "",
    entry.company || "",
    Array.isArray(entry.description) ? entry.description.join(" ") : entry.description || "",
  ]
    .join(" ")
    .toLowerCase();

  // 1. Keyword overlap (0-50 points)
  const allSkills = [
    ...(jobData.requiredSkills || []),
    ...(jobData.preferredSkills || []),
  ];

  if (allSkills.length > 0) {
    let matched = 0;
    for (const skill of allSkills) {
      const name = (typeof skill === "string" ? skill : skill.name || "").toLowerCase();
      if (name && entryText.includes(name)) {
        matched += skill.importance === "must_have" ? 2 : 1;
      }
    }
    const maxPoints = allSkills.reduce(
      (sum, s) => sum + (s.importance === "must_have" ? 2 : 1),
      0
    );
    score += Math.min(50, Math.round((matched / Math.max(maxPoints, 1)) * 50));
  }

  // 2. Title similarity (0-30 points)
  const jobTitle = (jobData.detectedJobTitle || "").toLowerCase();
  const entryTitle = (entry.role || entry.title || "").toLowerCase();

  if (jobTitle && entryTitle) {
    // Word overlap between job title and role title
    const jobWords = jobTitle.split(/\s+/).filter((w) => w.length > 2);
    const roleWords = entryTitle.split(/\s+/).filter((w) => w.length > 2);
    const overlap = jobWords.filter((w) => roleWords.some((r) => r.includes(w) || w.includes(r)));
    if (jobWords.length > 0) {
      score += Math.round((overlap.length / jobWords.length) * 30);
    }
  }

  // 3. Recency (0-20 points)
  const endStr = (entry.endDate || "").toLowerCase();
  if (endStr.includes("present") || endStr.includes("current") || endStr === "") {
    score += 20; // Current role
  } else {
    // Try to parse year
    const yearMatch = endStr.match(/(\d{4})/);
    if (yearMatch) {
      const year = parseInt(yearMatch[1]);
      const currentYear = new Date().getFullYear();
      const diff = currentYear - year;
      if (diff <= 1) score += 18;
      else if (diff <= 3) score += 12;
      else if (diff <= 5) score += 6;
      // else 0
    }
  }

  return Math.min(100, score);
};

/**
 * Score relevance for a project entry.
 */
const scoreProjectRelevance = (project, jobData) => {
  let score = 0;

  const projectText = [
    project.title || "",
    Array.isArray(project.description) ? project.description.join(" ") : project.description || "",
  ]
    .join(" ")
    .toLowerCase();

  const allSkills = [
    ...(jobData.requiredSkills || []),
    ...(jobData.preferredSkills || []),
  ];

  if (allSkills.length > 0) {
    let matched = 0;
    for (const skill of allSkills) {
      const name = (typeof skill === "string" ? skill : skill.name || "").toLowerCase();
      if (name && projectText.includes(name)) {
        matched += skill.importance === "must_have" ? 2 : 1;
      }
    }
    const maxPoints = allSkills.reduce(
      (sum, s) => sum + (s.importance === "must_have" ? 2 : 1),
      0
    );
    score += Math.min(70, Math.round((matched / Math.max(maxPoints, 1)) * 70));
  }

  // Title keyword overlap with job title
  const jobTitle = (jobData.detectedJobTitle || "").toLowerCase();
  const projTitle = (project.title || "").toLowerCase();
  if (jobTitle && projTitle) {
    const jobWords = jobTitle.split(/\s+/).filter((w) => w.length > 2);
    const overlap = jobWords.filter((w) => projTitle.includes(w));
    if (jobWords.length > 0) {
      score += Math.round((overlap.length / jobWords.length) * 30);
    }
  }

  return Math.min(100, score);
};

/**
 * Rank and annotate experiences by relevance.
 * Returns sorted array with relevanceScore and bulletCount.
 */
const rankExperiences = (experiences, jobData) => {
  if (!experiences || experiences.length === 0) return [];

  return experiences
    .map((exp) => ({
      ...exp,
      relevanceScore: scoreRelevance(exp, jobData),
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .map((exp, idx) => ({
      ...exp,
      // Most relevant roles get more bullets
      targetBulletCount: exp.relevanceScore >= 50 ? 5 : exp.relevanceScore >= 25 ? 3 : 2,
      displayOrder: idx,
    }));
};

/**
 * Rank projects by relevance.
 */
const rankProjects = (projects, jobData) => {
  if (!projects || projects.length === 0) return [];

  return projects
    .map((proj) => ({
      ...proj,
      relevanceScore: scoreProjectRelevance(proj, jobData),
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
};

// ─── Stage 4: Keyword Gap-Fill ───

/**
 * Identify JD keywords missing from the CV content and determine
 * the best section to insert them.
 */
const findKeywordGaps = (candidateSkills, jobData) => {
  const candidateNormalized = normalizeSkills(
    candidateSkills.map((s) => (typeof s === "string" ? s : s.name))
  );
  const candidateSet = new Set(
    candidateNormalized.map((s) => s.canonical.toLowerCase())
  );

  const missingKeywords = [];

  const allRequired = [
    ...(jobData.requiredSkills || []).map((s) => ({ ...s, importance: "must_have" })),
    ...(jobData.preferredSkills || []).map((s) => ({ ...s, importance: "nice_to_have" })),
  ];

  for (const req of allRequired) {
    const norm = normalizeSkill(typeof req === "string" ? req : req.name);
    if (!candidateSet.has(norm.canonical.toLowerCase())) {
      missingKeywords.push({
        name: norm.canonical,
        importance: req.importance || "nice_to_have",
      });
    }
  }

  return missingKeywords;
};

/**
 * Build the optimized skills list:
 * 1. Candidate's existing skills (normalized)
 * 2. Inferred skills from context (moderate hallucination — only obvious inferences)
 * 3. Ordered: matched JD skills first, then others
 */
const buildOptimizedSkills = (candidateSkills, jobData) => {
  const normalized = normalizeSkills(
    candidateSkills.map((s) => (typeof s === "string" ? s : s.name))
  );
  const candidateSet = new Set(normalized.map((s) => s.canonical.toLowerCase()));

  // Build categorized list, JD-matched skills first
  const allRequired = [
    ...(jobData.requiredSkills || []),
    ...(jobData.preferredSkills || []),
  ];

  const jdMatched = [];
  const jdNames = new Set();

  for (const req of allRequired) {
    const norm = normalizeSkill(typeof req === "string" ? req : req.name);
    if (candidateSet.has(norm.canonical.toLowerCase())) {
      jdMatched.push({
        name: norm.canonical,
        category: "Core Skills",
        isAutoGenerated: true,
      });
      jdNames.add(norm.canonical.toLowerCase());
    }
  }

  // Add remaining candidate skills
  const others = normalized
    .filter((s) => !jdNames.has(s.canonical.toLowerCase()))
    .map((s) => ({
      name: s.canonical,
      category: "Additional Skills",
      isAutoGenerated: true,
    }));

  return [...jdMatched, ...others];
};

// ─── Stage 5: Assembly ───

/**
 * Assemble the final DraftCV-compatible object.
 *
 * @param {object} params
 * @param {object} params.user - User document (for personal info)
 * @param {object} params.aiEnhanced - AI-enhanced content (summary, experiences, projects)
 * @param {object} params.candidateData - Original extracted candidate data
 * @param {object} params.jobData - Extracted job requirements
 * @param {object} params.job - Job document (for title)
 * @returns {object} DraftCV-ready object
 */
const assembleDraftCV = ({ user, aiEnhanced, candidateData, jobData, job }) => {
  const skills = buildOptimizedSkills(
    aiEnhanced.skills || candidateData.skills || [],
    jobData
  );

  return {
    title: `Optimized for ${job?.title || jobData.detectedJobTitle || "Target Role"}`,
    source: "upload",
    targetJob: {
      title: jobData.detectedJobTitle || job?.title || "",
      description: job?.description?.substring(0, 500) || "",
    },
    personalInfo: {
      fullName: user.firstName ? `${user.firstName} ${user.lastName || ""}`.trim() : "Candidate",
      email: user.email || "",
      phone: user.phone || "",
      linkedin: user.linkedinUrl || "",
      website: user.portfolioUrl || "",
      address: user.location || "",
    },
    professionalSummary: aiEnhanced.professionalSummary || candidateData.summary || "",
    experience: (aiEnhanced.experience || []).map((exp) => ({
      title: exp.title || exp.role || "",
      company: exp.company || "",
      startDate: exp.startDate || "",
      endDate: exp.endDate || "",
      isCurrent: (exp.endDate || "").toLowerCase().includes("present"),
      description: Array.isArray(exp.bullets)
        ? exp.bullets.map((b) => `• ${b}`).join("\n")
        : exp.description || "",
    })),
    education: (candidateData.education || []).map((edu) => ({
      degree: edu.degree || "",
      school: edu.school || "",
      field: edu.field || "",
      graduationDate: edu.date || edu.graduationDate || "",
    })),
    projects: (aiEnhanced.projects || []).map((proj) => ({
      title: proj.title || "",
      link: proj.link || "",
      description: Array.isArray(proj.bullets)
        ? proj.bullets.map((b) => `• ${b}`).join("\n")
        : proj.description || "",
    })),
    skills,
    isComplete: true,
  };
};

module.exports = {
  scoreRelevance,
  scoreProjectRelevance,
  rankExperiences,
  rankProjects,
  findKeywordGaps,
  buildOptimizedSkills,
  assembleDraftCV,
};
