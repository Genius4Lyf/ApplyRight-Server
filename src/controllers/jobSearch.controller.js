const jobSearchService = require("../services/jobSearch.service");
const cvTailorService = require("../services/cvTailor.service");
const JobSearch = require("../models/JobSearch");
const DraftCV = require("../models/DraftCV");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const SystemSettings = require("../models/SystemSettings");

const DEFAULT_PAGE_SIZE = 10;

/**
 * Filter results by source (global = adzuna, local = jobberman, mixed = all)
 */
const filterBySource = (results, source) => {
  if (!source || source === "mixed") return results;
  if (source === "global") return results.filter((r) => r.source !== "jobberman");
  if (source === "local") return results.filter((r) => r.source === "jobberman");
  return results;
};

/**
 * Paginate an array of results
 */
const paginate = (results, page = 1, limit = DEFAULT_PAGE_SIZE) => {
  const p = Math.max(1, parseInt(page) || 1);
  const l = Math.min(50, Math.max(1, parseInt(limit) || DEFAULT_PAGE_SIZE));
  const totalCount = results.length;
  const totalPages = Math.ceil(totalCount / l);
  const start = (p - 1) * l;
  const paginatedResults = results.slice(start, start + l);

  return {
    results: paginatedResults,
    pagination: {
      page: p,
      limit: l,
      totalCount,
      totalPages,
      hasNextPage: p < totalPages,
      hasPrevPage: p > 1,
    },
  };
};

// @desc    Search jobs from Adzuna + Jobberman
// @route   POST /api/job-search/search
// @access  Private
const searchJobs = async (req, res) => {
  try {
    const { keywords, location, country, jobType, remote, source, page, limit } = req.body;
    const userId = req.user.id;

    const user = await User.findById(userId);
    const query = jobSearchService.buildSearchQuery(user.jobProfile, null, {
      keywords,
      location,
      country,
      jobType,
      remote,
    });

    if (!query.keywords) {
      return res.status(400).json({ message: "Please provide search keywords or complete your job profile" });
    }

    // Perform search
    const sourceFilter = source || "mixed";

    // Check DB cache first (always pass source to avoid cross-tab collisions)
    const cached = await jobSearchService.getCachedSearch(query, userId, sourceFilter);
    if (cached) {
      const paged = paginate(cached.results || [], page, limit);
      return res.json({ _id: cached._id, searchId: cached._id, ...paged });
    }
    const searchData = await jobSearchService.search(query, sourceFilter);

    // Score against CV if available
    const latestCV = await DraftCV.findOne({ userId, isComplete: true }).sort({ updatedAt: -1 });
    const scoredResults = jobSearchService.scoreResults(searchData.results, latestCV);

    // Save to DB
    const saved = await jobSearchService.saveSearch(
      userId,
      query,
      scoredResults,
      latestCV?._id,
      sourceFilter
    );

    const paged = paginate(scoredResults, page, limit);
    res.json({ _id: saved._id, searchId: saved._id, ...paged });
  } catch (error) {
    console.error("Job search error:", error.message);
    res.status(500).json({ message: "Failed to search jobs" });
  }
};

// @desc    Get trending jobs (no profile needed)
// @route   GET /api/job-search/trending
// @access  Private
const getTrendingJobs = async (req, res) => {
  try {
    const { source, page, limit } = req.query;
    const sourceFilter = source || "mixed";
    const userId = req.user.id;

    // Check if we already have a cached trending search for this user + source
    const query = { keywords: "trending", location: "", country: "ng", jobType: "", remote: false };
    const cached = await jobSearchService.getCachedSearch(query, userId, sourceFilter);
    if (cached) {
      const filteredResults = filterBySource(cached.results || [], sourceFilter);
      const paged = paginate(filteredResults, page, limit);
      return res.json({ _id: cached._id, searchId: cached._id, ...paged, categories: [] });
    }

    const data = await jobSearchService.searchTrending(sourceFilter);

    // Save to DB so save/bookmark works
    const saved = await jobSearchService.saveSearch(
      userId,
      query,
      data.results || [],
      null,
      sourceFilter
    );

    const paged = paginate(data.results || [], page, limit);
    res.json({ _id: saved._id, searchId: saved._id, ...paged, categories: data.categories });
  } catch (error) {
    console.error("Trending jobs error:", error.message);
    res.status(500).json({ message: "Failed to load trending jobs" });
  }
};

// @desc    Browse jobs by source without profile (Global/Local tabs)
// @route   GET /api/job-search/browse
// @access  Private
const browseJobs = async (req, res) => {
  try {
    const { source, page, limit } = req.query;
    const sourceFilter = source || "mixed";
    const userId = req.user.id;

    const query = { keywords: "jobs", location: "", country: "ng", jobType: "", remote: false };

    // Check DB cache
    const cached = await jobSearchService.getCachedSearch(query, userId, sourceFilter);
    if (cached) {
      const filteredResults = filterBySource(cached.results || [], sourceFilter);
      const paged = paginate(filteredResults, page, limit);
      return res.json({ _id: cached._id, searchId: cached._id, ...paged });
    }

    const data = await jobSearchService.search(query, sourceFilter);

    // Save to DB so save/bookmark works
    const saved = await jobSearchService.saveSearch(
      userId,
      query,
      data.results || [],
      null,
      sourceFilter
    );

    const paged = paginate(data.results || [], page, limit);
    res.json({ _id: saved._id, searchId: saved._id, ...paged });
  } catch (error) {
    console.error("Browse jobs error:", error.message);
    res.status(500).json({ message: "Failed to browse jobs" });
  }
};

// @desc    Get cached search results
// @route   GET /api/job-search/search/:searchId
// @access  Private
const getSearchResults = async (req, res) => {
  try {
    const search = await JobSearch.findOne({
      _id: req.params.searchId,
      userId: req.user.id,
    });

    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    res.json(search);
  } catch (error) {
    console.error("Get search error:", error.message);
    res.status(500).json({ message: "Failed to get search results" });
  }
};

// @desc    Get auto-matched job recommendations from profile/CV
// @route   GET /api/job-search/recommendations
// @access  Private
const getRecommendations = async (req, res) => {
  try {
    const { page, limit } = req.query;
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user.jobProfile?.desiredTitle) {
      return res.json({ results: [], pagination: { page: 1, limit: 10, totalCount: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false }, message: "Set up your job preferences to see personalized recommendations" });
    }

    // Build query from profile
    const latestCV = await DraftCV.findOne({ userId, isComplete: true }).sort({ updatedAt: -1 });
    const query = jobSearchService.buildSearchQuery(user.jobProfile, latestCV);

    if (!query.keywords) {
      return res.json({ results: [], pagination: { page: 1, limit: 10, totalCount: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false }, message: "Add a desired job title to see recommendations" });
    }

    // Check cache
    const scoredAgainstInfo = latestCV ? { _id: latestCV._id, title: latestCV.title || latestCV.targetJob?.title || "Untitled CV" } : null;
    const cached = await jobSearchService.getCachedSearch(query, userId, "mixed");
    if (cached) {
      const paged = paginate(cached.results || [], page, limit);
      return res.json({ searchId: cached._id, ...paged, scoredAgainst: scoredAgainstInfo });
    }

    // Progressive fallback: try the full query first, then relax filters
    // until we get results. This ensures users always see something.
    const fallbackQueries = [
      query, // 1. Full query (title + skills + location + jobType)
      { ...query, location: "", jobType: "" }, // 2. Drop location & jobType
      { ...query, location: "", jobType: "", keywords: user.jobProfile.desiredTitle }, // 3. Just the title (no appended skills)
    ];

    let searchData = null;
    let usedQuery = query;

    for (const q of fallbackQueries) {
      searchData = await jobSearchService.search(q);
      if (searchData.results?.length > 0) {
        usedQuery = q;
        break;
      }
    }

    const scoredResults = jobSearchService.scoreResults(searchData.results || [], latestCV);

    // Save and return paginated results
    const saved = await jobSearchService.saveSearch(userId, usedQuery, scoredResults, latestCV?._id, "mixed");

    const paged = paginate(scoredResults, page, limit);
    res.json({
      searchId: saved._id,
      ...paged,
      scoredAgainst: scoredAgainstInfo,
    });
  } catch (error) {
    console.error("Recommendations error:", error.message);
    res.status(500).json({ message: "Failed to get recommendations" });
  }
};

// @desc    Get full job description
// @route   POST /api/job-search/:searchId/details/:resultId
// @access  Private
const getJobDetails = async (req, res) => {
  try {
    const { searchId, resultId } = req.params;

    const search = await JobSearch.findOne({
      _id: searchId,
      userId: req.user.id,
    });

    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    const result = search.results.id(resultId);
    if (!result) {
      return res.status(404).json({ message: "Job result not found" });
    }

    // Fetch full description if not cached
    if (!result.fullDescription) {
      const fullDesc = await jobSearchService.getJobDetails(result);
      result.fullDescription = fullDesc;
      await search.save();
    }

    res.json(result);
  } catch (error) {
    console.error("Job details error:", error.message);
    res.status(500).json({ message: "Failed to get job details" });
  }
};

// @desc    Track click on apply link (CPC tracking)
// @route   POST /api/job-search/:searchId/click/:resultId
// @access  Private
const trackClick = async (req, res) => {
  try {
    const { searchId, resultId } = req.params;

    const search = await JobSearch.findOne({
      _id: searchId,
      userId: req.user.id,
    });

    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    const result = search.results.id(resultId);
    if (!result) {
      return res.status(404).json({ message: "Job result not found" });
    }

    result.clicked = true;
    result.clickedAt = new Date();
    await search.save();

    res.json({ success: true, applyUrl: result.applyUrl });
  } catch (error) {
    console.error("Click tracking error:", error.message);
    res.status(500).json({ message: "Failed to track click" });
  }
};

// @desc    Toggle save/bookmark a job
// @route   POST /api/job-search/:searchId/save/:resultId
// @access  Private
const toggleSave = async (req, res) => {
  try {
    const { searchId, resultId } = req.params;

    const search = await JobSearch.findOne({
      _id: searchId,
      userId: req.user.id,
    });

    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    const result = search.results.id(resultId);
    if (!result) {
      return res.status(404).json({ message: "Job result not found" });
    }

    result.saved = !result.saved;
    await search.save();

    res.json({ saved: result.saved });
  } catch (error) {
    console.error("Toggle save error:", error.message);
    res.status(500).json({ message: "Failed to save job" });
  }
};

// @desc    Get all saved/bookmarked jobs
// @route   GET /api/job-search/saved
// @access  Private
const getSavedJobs = async (req, res) => {
  try {
    const { page, limit } = req.query;

    const searches = await JobSearch.find({
      userId: req.user.id,
      "results.saved": true,
    });

    const savedJobs = [];
    for (const search of searches) {
      for (const result of search.results) {
        if (result.saved) {
          savedJobs.push({
            ...result.toObject(),
            searchId: search._id,
          });
        }
      }
    }

    // Sort by save date (most recent first)
    savedJobs.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    const paged = paginate(savedJobs, page, limit);
    res.json(paged);
  } catch (error) {
    console.error("Saved jobs error:", error.message);
    res.status(500).json({ message: "Failed to get saved jobs" });
  }
};

// @desc    Tailor CV for a specific job
// @route   POST /api/job-search/:searchId/tailor/:resultId
// @access  Private (costs credits)
const tailorCV = async (req, res) => {
  try {
    const { searchId, resultId } = req.params;
    const { cvId } = req.body;
    const userId = req.user.id;

    // Get credit cost from settings
    const settings = await SystemSettings.getInstance();
    const cost = settings.credits.tailorCVCost || 15;

    // Check credits
    const user = await User.findById(userId);
    if (user.credits < cost) {
      return res.status(402).json({
        message: "Insufficient credits",
        required: cost,
        available: user.credits,
      });
    }

    // Get the job result
    const search = await JobSearch.findOne({ _id: searchId, userId });
    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    const result = search.results.id(resultId);
    if (!result) {
      return res.status(404).json({ message: "Job result not found" });
    }

    // Determine which CV to tailor
    const sourceCVId = cvId || search.sourceCV;
    if (!sourceCVId) {
      return res.status(400).json({ message: "Please specify a CV to tailor" });
    }

    // Fetch full description if needed
    if (!result.fullDescription) {
      const fullDesc = await jobSearchService.getJobDetails(result);
      result.fullDescription = fullDesc;
      await search.save();
    }

    // Tailor the CV
    const tailoredCV = await cvTailorService.tailorCV(sourceCVId, {
      title: result.title,
      company: result.company,
      description: result.fullDescription || result.snippet,
      externalId: result.externalId,
      source: result.source,
    }, userId);

    // Deduct credits
    user.credits -= cost;
    await user.save();

    // Record transaction
    await Transaction.create({
      userId,
      amount: -cost,
      type: "cv_tailor",
      description: `CV tailored for ${result.title} at ${result.company}`,
      status: "completed",
    });

    // Extract atsScores from tailoredCV (added by cvTailor.service)
    const { atsScores, ...tailoredCVData } = tailoredCV;

    // Save to Application record for job history
    const Application = require("../models/Application");
    let applicationId = null;
    try {
      const application = await Application.create({
        userId,
        resumeId: sourceCVId,
        jobId: search._id,
        draftCVId: tailoredCVData._id,
        jobTitle: result.title,
        jobCompany: result.company,
        fitScore: atsScores?.after?.fitScore || atsScores?.before?.fitScore || null,
        fitAnalysis: {
          recommendation: atsScores?.after?.recommendation || "",
          matchedSkills: atsScores?.after?.matchedSkills || [],
          missingSkills: atsScores?.after?.missingSkills || [],
        },
      });
      applicationId = application._id;
    } catch (appErr) {
      console.error("Failed to save Application record for tailor:", appErr.message);
    }

    res.json({
      tailoredCV: tailoredCVData,
      remainingCredits: user.credits,
      atsScores,
      applicationId,
    });
  } catch (error) {
    console.error("Tailor CV error:", error.message);
    console.error("Tailor CV stack:", error.stack);
    res.status(500).json({ message: "Failed to tailor CV", error: error.message });
  }
};

// @desc    Tailor CV + cover letter + interview prep bundle
// @route   POST /api/job-search/:searchId/tailor-bundle/:resultId
// @access  Private (costs credits)
const tailorBundle = async (req, res) => {
  try {
    const { searchId, resultId } = req.params;
    const { cvId } = req.body;
    const userId = req.user.id;

    const settings = await SystemSettings.getInstance();
    const cost = settings.credits.tailorBundleCost || 20;

    const user = await User.findById(userId);
    if (user.credits < cost) {
      return res.status(402).json({
        message: "Insufficient credits",
        required: cost,
        available: user.credits,
      });
    }

    // Get the job result
    const search = await JobSearch.findOne({ _id: searchId, userId });
    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    const result = search.results.id(resultId);
    if (!result) {
      return res.status(404).json({ message: "Job result not found" });
    }

    const sourceCVId = cvId || search.sourceCV;
    if (!sourceCVId) {
      return res.status(400).json({ message: "Please specify a CV to tailor" });
    }

    // Fetch full description if needed
    if (!result.fullDescription) {
      const fullDesc = await jobSearchService.getJobDetails(result);
      result.fullDescription = fullDesc;
      await search.save();
    }

    const jobDescription = result.fullDescription || result.snippet;

    // Load the source CV for resume text
    const sourceCV = await DraftCV.findOne({ _id: sourceCVId, userId });
    if (!sourceCV) {
      return res.status(404).json({ message: "Source CV not found" });
    }

    // Run all three in parallel: tailor CV + cover letter + interview questions
    const aiService = require("../services/ai.service");
    const resumeText = buildResumeText(sourceCV);

    const [tailoredCV, coverLetterResult, interviewResult] = await Promise.all([
      cvTailorService.tailorCV(sourceCVId, {
        title: result.title,
        company: result.company,
        description: jobDescription,
        externalId: result.externalId,
        source: result.source,
      }, userId),
      aiService.generateCoverLetter(resumeText, jobDescription).catch(() => ""),
      aiService.generateInterviewQuestions
        ? aiService.generateInterviewQuestions(jobDescription, resumeText).catch(() => ({ questionsToAnswer: [], questionsToAsk: [] }))
        : Promise.resolve({ questionsToAnswer: [], questionsToAsk: [] }),
    ]);

    // Normalize interview result — AI returns { questionsToAnswer, questionsToAsk }
    const interviewData = interviewResult && typeof interviewResult === "object" && !Array.isArray(interviewResult)
      ? interviewResult
      : { questionsToAnswer: Array.isArray(interviewResult) ? interviewResult : [], questionsToAsk: [] };

    const questionsToAnswer = Array.isArray(interviewData.questionsToAnswer) ? interviewData.questionsToAnswer : [];
    const questionsToAsk = Array.isArray(interviewData.questionsToAsk) ? interviewData.questionsToAsk : [];

    // Deduct credits
    user.credits -= cost;
    await user.save();

    await Transaction.create({
      userId,
      amount: -cost,
      type: "tailor_bundle",
      description: `Bundle: CV + Cover Letter + Interview for ${result.title} at ${result.company}`,
      status: "completed",
    });

    // Extract atsScores from tailoredCV
    const { atsScores, ...tailoredCVData } = tailoredCV;

    // Save bundle data to an Application record so the user can view it later
    const Application = require("../models/Application");
    let applicationId = null;
    try {
      const application = await Application.create({
        userId,
        resumeId: sourceCVId,
        jobId: search._id,
        draftCVId: tailoredCVData._id,
        jobTitle: result.title,
        jobCompany: result.company,
        coverLetter: coverLetterResult || "",
        interviewQuestions: questionsToAnswer,
        questionsToAsk: questionsToAsk,
        fitScore: atsScores?.after?.fitScore || atsScores?.before?.fitScore || null,
        fitAnalysis: {
          recommendation: atsScores?.after?.recommendation || "",
          matchedSkills: atsScores?.after?.matchedSkills || [],
          missingSkills: atsScores?.after?.missingSkills || [],
        },
      });
      applicationId = application._id;
    } catch (appErr) {
      console.error("Failed to save Application record:", appErr.message);
    }

    res.json({
      tailoredCV: tailoredCVData,
      coverLetter: coverLetterResult,
      interviewQuestions: questionsToAnswer,
      questionsToAsk: questionsToAsk,
      remainingCredits: user.credits,
      atsScores,
      applicationId,
    });
  } catch (error) {
    console.error("Tailor bundle error:", error.message);
    res.status(500).json({ message: "Failed to generate bundle" });
  }
};

// @desc    Update user's job profile (onboarding)
// @route   PUT /api/job-search/profile
// @access  Private
const updateJobProfile = async (req, res) => {
  try {
    const { desiredTitle, preferredLocation, jobType, experienceLevel, topSkills, salaryExpectation } = req.body;

    if (!desiredTitle) {
      return res.status(400).json({ message: "Desired job title is required" });
    }

    const user = await User.findById(req.user.id);

    user.jobProfile = {
      desiredTitle,
      preferredLocation: preferredLocation || {},
      jobType: jobType || "",
      experienceLevel: experienceLevel || "",
      topSkills: (topSkills || []).slice(0, 5),
      salaryExpectation: salaryExpectation || {},
    };
    user.onboardingCompleted = true;

    await user.save();

    res.json({ jobProfile: user.jobProfile, onboardingCompleted: true });
  } catch (error) {
    console.error("Update profile error:", error.message);
    res.status(500).json({ message: "Failed to update job profile" });
  }
};

/**
 * Build plain-text resume from CV data (helper for bundle)
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

  if (cv.skills?.length) {
    parts.push(`Skills: ${cv.skills.map((s) => s.name).join(", ")}`);
  }

  return parts.join("\n");
};

// @desc    Quick ATS score (no credits, deterministic)
// @route   POST /api/job-search/:searchId/quick-score/:resultId
// @access  Private
const quickScore = async (req, res) => {
  try {
    const { searchId, resultId } = req.params;
    const { cvId } = req.body;
    const userId = req.user.id;

    if (!cvId) {
      return res.status(400).json({ message: "Please specify a CV" });
    }

    const search = await JobSearch.findOne({ _id: searchId, userId });
    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    const result = search.results.id(resultId);
    if (!result) {
      return res.status(404).json({ message: "Job result not found" });
    }

    // Fetch full description if needed
    if (!result.fullDescription) {
      const fullDesc = await jobSearchService.getJobDetails(result);
      result.fullDescription = fullDesc;
      await search.save();
    }

    const description = result.fullDescription || result.snippet;
    const scoreResult = await cvTailorService.quickScoreCV(cvId, description, userId, result.title);

    res.json(scoreResult);
  } catch (error) {
    console.error("Quick score error:", error.message);
    res.status(500).json({ message: "Failed to compute score" });
  }
};

module.exports = {
  searchJobs,
  getSearchResults,
  getTrendingJobs,
  browseJobs,
  getRecommendations,
  getJobDetails,
  trackClick,
  toggleSave,
  getSavedJobs,
  tailorCV,
  tailorBundle,
  updateJobProfile,
  quickScore,
};
