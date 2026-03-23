const DraftCV = require("../models/DraftCV");
const aiService = require("./ai.service");
const { computeFitScore } = require("./scoringEngine.service");
const extractionService = require("./extraction.service");

/**
 * Clone and tailor a CV for a specific job
 *
 * @param {string} draftCVId - The source CV to clone
 * @param {object} jobData - { title, company, description, externalId, source }
 * @param {string} userId - The user who owns the CV
 * @returns {object} The new tailored DraftCV document
 */
const tailorCV = async (draftCVId, jobData, userId) => {
  console.log("[tailorCV] Starting for CV:", draftCVId, "user:", userId);

  // 1. Load original CV
  const original = await DraftCV.findOne({ _id: draftCVId, userId });
  if (!original) {
    throw new Error("CV not found or access denied");
  }
  console.log("[tailorCV] Step 1 OK - loaded original CV:", original.title);

  // 2. Build resume text from CV data for AI analysis
  const resumeText = buildResumeText(original);
  console.log("[tailorCV] Step 2 OK - built resume text, length:", resumeText.length);

  // 2b. Compute before-score and extract missing keywords for AI
  let beforeScore = null;
  let jobDataForScoring = null;
  let missingKeywords = [];
  try {
    const jobRequirements = extractionService.extractRequirements(jobData.description || "");
    const candidateDataForScoring = mapToScoringFormat(original);
    jobDataForScoring = mapJobToScoringFormat(jobRequirements, jobData.title, jobData.description);
    beforeScore = computeFitScore({ candidateData: candidateDataForScoring, jobData: jobDataForScoring });
    missingKeywords = (beforeScore.missingSkills || []).map((s) => s.name);
    console.log("[tailorCV] Step 2b OK - before score:", beforeScore.fitScore, "missing keywords:", missingKeywords);
  } catch (scoreErr) {
    console.error("[tailorCV] Pre-tailor scoring failed (non-fatal):", scoreErr.message);
  }

  // 3. Use existing AI service to enhance the CV for this specific job
  console.log("[tailorCV] Step 3 - calling AI enhanceCVContent...");
  const enhanced = await aiService.enhanceCVContent({
    candidateData: {
      skills: original.skills || [],
      experience: original.experience || [],
      projects: original.projects || [],
      summary: original.professionalSummary || "",
      education: original.education || [],
    },
    jobData: {
      title: jobData.title,
      description: jobData.description,
      company: jobData.company,
    },
    rankedExperiences: original.experience || [],
    rankedProjects: original.projects || [],
    missingKeywords,
  });
  console.log("[tailorCV] Step 3 OK - AI enhancement done, has summary:", !!enhanced?.professionalSummary);

  // 4. Clone the CV with tailored content
  const cloneData = {
    userId,
    title: `CV - Tailored for ${jobData.title} at ${jobData.company}`,
    source: original.source,
    targetJob: {
      title: jobData.title,
      description: jobData.description,
    },
    personalInfo: original.personalInfo,
    professionalSummary: enhanced?.professionalSummary || original.professionalSummary,
    experience: mergeExperience(original.experience, enhanced?.experience),
    projects: mergeProjects(original.projects, enhanced?.projects),
    education: original.education,
    skills: enhanced?.skills?.length
      ? enhanced.skills.map((s) => {
          if (typeof s !== "string") return s;
          // Preserve category from original CV if the skill already existed
          const orig = (original.skills || []).find(
            (o) => o.name && o.name.toLowerCase() === s.toLowerCase()
          );
          return { name: s, category: orig?.category || "General" };
        })
      : original.skills,
    isComplete: true,
    currentStep: "finalize",
    tailoredFrom: original._id,
    tailoredForJob: {
      title: jobData.title,
      company: jobData.company,
      externalId: jobData.externalId,
      source: jobData.source,
    },
  };

  console.log("[tailorCV] Step 4 - creating DraftCV clone, source:", cloneData.source);
  const tailoredCV = await DraftCV.create(cloneData);
  console.log("[tailorCV] Step 4 OK - created tailored CV:", tailoredCV._id);

  // Compute after-score on the tailored CV
  let atsScores = null;
  if (beforeScore && jobDataForScoring) {
    try {
      const afterCandidateData = mapToScoringFormat(tailoredCV);
      const afterScore = computeFitScore({ candidateData: afterCandidateData, jobData: jobDataForScoring });
      atsScores = {
        before: { fitScore: beforeScore.fitScore, matchedSkills: beforeScore.matchedSkills, missingSkills: beforeScore.missingSkills, recommendation: beforeScore.recommendation },
        after: { fitScore: afterScore.fitScore, matchedSkills: afterScore.matchedSkills, missingSkills: afterScore.missingSkills, recommendation: afterScore.recommendation },
      };
    } catch (scoreErr) {
      console.error("Post-tailor scoring failed (non-fatal):", scoreErr.message);
    }
  }

  return {
    ...tailoredCV.toObject(),
    atsScores,
  };
};

/**
 * Build a plain-text resume from DraftCV data for AI consumption
 */
const buildResumeText = (cv) => {
  const parts = [];

  if (cv.personalInfo?.fullName) parts.push(cv.personalInfo.fullName);
  if (cv.professionalSummary) parts.push(`Summary: ${cv.professionalSummary}`);

  if (cv.experience?.length) {
    parts.push("Experience:");
    cv.experience.forEach((exp) => {
      parts.push(`- ${exp.title} at ${exp.company} (${exp.startDate || ""} - ${exp.endDate || "Present"})`);
      if (exp.description) parts.push(`  ${exp.description}`);
    });
  }

  if (cv.projects?.length) {
    parts.push("Projects:");
    cv.projects.forEach((proj) => {
      parts.push(`- ${proj.title}`);
      if (proj.description) parts.push(`  ${proj.description}`);
    });
  }

  if (cv.education?.length) {
    parts.push("Education:");
    cv.education.forEach((edu) => {
      parts.push(`- ${edu.degree} at ${edu.school}`);
    });
  }

  if (cv.skills?.length) {
    parts.push(`Skills: ${cv.skills.map((s) => s.name).join(", ")}`);
  }

  return parts.join("\n");
};

/**
 * Merge original experience with AI-enhanced descriptions
 * Preserves titles, companies, dates — only updates descriptions
 */
const mergeExperience = (original, enhanced) => {
  if (!enhanced?.length) return original || [];
  return (original || []).map((orig, i) => {
    const match = enhanced[i];
    if (!match) return orig;
    return {
      ...orig,
      description: match.description || orig.description,
    };
  });
};

/**
 * Merge original projects with AI-enhanced descriptions
 */
const mergeProjects = (original, enhanced) => {
  if (!enhanced?.length) return original || [];
  return (original || []).map((orig, i) => {
    const match = enhanced[i];
    if (!match) return orig;
    return {
      ...orig,
      description: match.description || orig.description,
    };
  });
};

/**
 * Map DraftCV to the format expected by computeFitScore
 */
const mapToScoringFormat = (cv) => ({
  skills: (cv.skills || []).map((s) => (typeof s === "string" ? s : s.name)),
  experience: cv.experience || [],
  projects: cv.projects || [],
  education: cv.education || [],
  summary: cv.professionalSummary || "",
  totalYearsExperience: estimateTotalYears(cv.experience || []),
  seniorityLevel: "mid",
});

/**
 * Map extracted job requirements to the format expected by computeFitScore
 */
const mapJobToScoringFormat = (requirements, jobTitle, jobDescription) => ({
  requiredSkills: (requirements.skills || [])
    .filter((s) => s.importance >= 3)
    .map((s) => ({ name: s.name, importance: "must_have" })),
  preferredSkills: (requirements.skills || [])
    .filter((s) => s.importance < 3)
    .map((s) => ({ name: s.name, importance: "nice_to_have" })),
  requiredYearsExperience: requirements.experience?.minYears || 0,
  requiredEducation: requirements.education?.degree !== "Unknown" ? requirements.education : null,
  seniorityLevel: requirements.seniority !== "unknown" ? requirements.seniority : null,
  jobTitle: jobTitle || "",
  jobDescription: jobDescription || "",
});

/**
 * Estimate total years of experience from experience entries
 */
const estimateTotalYears = (experiences) => {
  let total = 0;
  for (const exp of experiences) {
    if (exp.startDate) {
      const start = new Date(exp.startDate);
      const end = exp.endDate ? new Date(exp.endDate) : new Date();
      const years = (end - start) / (1000 * 60 * 60 * 24 * 365.25);
      if (years > 0) total += years;
    }
  }
  return Math.round(total);
};

/**
 * Quick score a CV against a job (no AI, no credits)
 */
const quickScoreCV = async (cvId, jobDescription, userId, jobTitle = "") => {
  const cv = await DraftCV.findOne({ _id: cvId, userId });
  if (!cv) throw new Error("CV not found or access denied");

  const jobRequirements = extractionService.extractRequirements(jobDescription);
  const candidateData = mapToScoringFormat(cv);
  const jobData = mapJobToScoringFormat(jobRequirements, jobTitle, jobDescription);
  const result = computeFitScore({ candidateData, jobData });

  return {
    fitScore: result.fitScore,
    matchedSkills: result.matchedSkills,
    missingSkills: result.missingSkills,
    recommendation: result.recommendation,
  };
};

module.exports = {
  tailorCV,
  quickScoreCV,
};
