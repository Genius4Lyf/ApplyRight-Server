const DraftCV = require("../models/DraftCV");
const aiService = require("./ai.service");

/**
 * Clone and tailor a CV for a specific job
 *
 * @param {string} draftCVId - The source CV to clone
 * @param {object} jobData - { title, company, description, externalId, source }
 * @param {string} userId - The user who owns the CV
 * @returns {object} The new tailored DraftCV document
 */
const tailorCV = async (draftCVId, jobData, userId) => {
  // 1. Load original CV
  const original = await DraftCV.findOne({ _id: draftCVId, userId });
  if (!original) {
    throw new Error("CV not found or access denied");
  }

  // 2. Build resume text from CV data for AI analysis
  const resumeText = buildResumeText(original);

  // 3. Use existing AI service to enhance the CV for this specific job
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
    missingKeywords: [],
  });

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
    skills: enhanced?.skills?.length ? enhanced.skills : original.skills,
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

  const tailoredCV = await DraftCV.create(cloneData);
  return tailoredCV;
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

module.exports = {
  tailorCV,
};
