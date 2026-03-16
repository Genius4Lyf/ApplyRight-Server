const adzunaService = require("./adzuna.service");
const jobbermanService = require("./jobberman.service");
const indeedService = require("./indeed.service");
const JobSearch = require("../models/JobSearch");

// In-memory cache for hot queries (TTL: 30 minutes)
const queryCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const DB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for DB cache

/**
 * Build a search query from user's job profile and optional CV data
 */
const buildSearchQuery = (jobProfile, draftCV, overrides = {}) => {
  let keywords = overrides.keywords || "";
  let location = overrides.location || "";
  let country = overrides.country || "";
  let jobType = overrides.jobType || "";
  let remote = overrides.remote || false;

  // Fill from job profile
  if (jobProfile) {
    if (!keywords) keywords = jobProfile.desiredTitle || "";
    if (!location && jobProfile.preferredLocation) {
      location = jobProfile.preferredLocation.city || "";
      if (!country) country = jobProfile.preferredLocation.country || "";
      if (!remote) remote = jobProfile.preferredLocation.remote || false;
    }
    if (!jobType) jobType = jobProfile.jobType || "";

    // Append top skills as supplementary keywords
    if (jobProfile.topSkills?.length && keywords) {
      const skillStr = jobProfile.topSkills.slice(0, 3).join(" ");
      keywords = `${keywords} ${skillStr}`;
    }
  }

  // Enrich from CV data if available
  if (draftCV) {
    if (!keywords && draftCV.targetJob?.title) {
      keywords = draftCV.targetJob.title;
    }
    // Add CV skills for richer search
    if (draftCV.skills?.length && !jobProfile?.topSkills?.length) {
      const cvSkills = draftCV.skills.slice(0, 3).map((s) => s.name).join(" ");
      keywords = keywords ? `${keywords} ${cvSkills}` : cvSkills;
    }
  }

  return {
    keywords: keywords.trim(),
    location: location.trim(),
    country: country.trim() || "ng",
    jobType,
    remote,
  };
};

/**
 * Search jobs from Adzuna, Jobberman, and Indeed
 */
const search = async (query, sourceFilter = "mixed") => {
  const cacheKey = JSON.stringify({ ...query, sourceFilter });

  // Check in-memory cache
  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const isNigeria = query.country.toLowerCase() === "ng";
  // Map frontend filter names: "global" = adzuna+indeed, "local" = jobberman, "mixed" = all
  const isGlobal = sourceFilter === "global";
  const isLocal = sourceFilter === "local";
  const isMixed = sourceFilter === "mixed";

  // Build promises array for all sources in parallel
  const sourcePromises = {};

  // Adzuna for international jobs
  if (isMixed || isGlobal || sourceFilter === "adzuna") {
    const adzunaCountry = isNigeria ? "gb" : query.country;
    const adzunaKeywords = query.remote ? `${query.keywords} remote` : query.keywords;
    sourcePromises.adzuna = adzunaService
      .searchJobs(adzunaKeywords, query.remote ? "" : query.location, adzunaCountry, query.jobType)
      .catch(() => ({ results: [], count: 0 }));
  }

  // Indeed for broad coverage (works globally including Nigeria)
  if (isMixed || isGlobal || sourceFilter === "indeed") {
    const indeedCountry = isNigeria && isGlobal ? "us" : query.country.toLowerCase();
    const indeedKeywords = query.remote ? `${query.keywords} remote` : query.keywords;
    sourcePromises.indeed = indeedService
      .searchJobs(indeedKeywords, query.location, indeedCountry, query.jobType)
      .catch(() => ({ results: [], count: 0 }));
  }

  // Jobberman for Nigerian jobs
  if (isMixed || isLocal || sourceFilter === "jobberman") {
    sourcePromises.jobberman = jobbermanService
      .searchJobs(query.keywords, query.location, query.jobType)
      .catch(() => ({ results: [], count: 0 }));
  }

  // Run all sources in parallel
  const keys = Object.keys(sourcePromises);
  const values = await Promise.all(Object.values(sourcePromises));
  const sourceData = {};
  keys.forEach((key, i) => {
    sourceData[key] = values[i];
  });

  // Merge all results
  const allResults = [
    ...(sourceData.adzuna?.results || []),
    ...(sourceData.indeed?.results || []),
    ...(sourceData.jobberman?.results || []),
  ];

  // Deduplicate by title+company (keep first occurrence — priority: adzuna > indeed > jobberman)
  const seen = new Set();
  const deduplicated = allResults.filter((r) => {
    const key = `${r.title.toLowerCase()}|${r.company.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date (newest first)
  deduplicated.sort((a, b) => new Date(b.postedDate) - new Date(a.postedDate));

  const result = {
    results: deduplicated,
    count: deduplicated.length,
    sources: {
      adzuna: sourceData.adzuna?.results?.length || 0,
      indeed: sourceData.indeed?.results?.length || 0,
      jobberman: sourceData.jobberman?.results?.length || 0,
    },
  };

  // Cache the result
  queryCache.set(cacheKey, { data: result, timestamp: Date.now() });

  return result;
};

/**
 * Score search results against a user's CV
 */
const scoreResults = (results, draftCV) => {
  if (!draftCV) {
    return results.map((r) => ({
      ...r,
      matchScore: null,
      matchBreakdown: {
        skillsScore: null,
        experienceScore: null,
        locationScore: null,
        titleScore: null,
      },
    }));
  }

  const cvSkills = (draftCV.skills || []).map((s) => s.name.toLowerCase());
  const cvTitle = (draftCV.targetJob?.title || "").toLowerCase();
  const cvLocation = (draftCV.personalInfo?.address || "").toLowerCase();
  const experienceYears = (draftCV.experience || []).length; // rough proxy

  return results.map((r) => {
    // Skills score: overlap between CV skills and job text
    const jobText = `${r.title} ${r.snippet} ${r.fullDescription}`.toLowerCase();
    const matchedSkills = cvSkills.filter((skill) => jobText.includes(skill));
    const skillsScore = cvSkills.length > 0
      ? Math.round((matchedSkills.length / cvSkills.length) * 100)
      : 50;

    // Title score: similarity between CV target job and job title
    const titleWords = cvTitle.split(/\s+/).filter(Boolean);
    const jobTitleLower = r.title.toLowerCase();
    const titleMatches = titleWords.filter((w) => jobTitleLower.includes(w));
    const titleScore = titleWords.length > 0
      ? Math.round((titleMatches.length / titleWords.length) * 100)
      : 50;

    // Location score
    const jobLocation = r.location.toLowerCase();
    let locationScore = 50; // neutral if no location data
    if (cvLocation && jobLocation) {
      if (jobLocation.includes(cvLocation) || cvLocation.includes(jobLocation)) {
        locationScore = 100;
      } else if (jobLocation.includes("remote")) {
        locationScore = 80;
      } else {
        locationScore = 30;
      }
    }

    // Experience score (rough heuristic)
    let experienceScore = 60;
    const seniorKeywords = ["senior", "lead", "principal", "staff", "manager", "director"];
    const juniorKeywords = ["junior", "entry", "intern", "graduate", "trainee"];
    const isSeniorRole = seniorKeywords.some((k) => jobTitleLower.includes(k));
    const isJuniorRole = juniorKeywords.some((k) => jobTitleLower.includes(k));

    if (isSeniorRole && experienceYears >= 3) experienceScore = 80;
    else if (isSeniorRole && experienceYears < 2) experienceScore = 30;
    else if (isJuniorRole && experienceYears <= 2) experienceScore = 90;
    else if (isJuniorRole && experienceYears > 4) experienceScore = 50;
    else experienceScore = 65;

    // Overall match score (weighted average)
    const matchScore = Math.round(
      skillsScore * 0.4 + titleScore * 0.3 + experienceScore * 0.2 + locationScore * 0.1
    );

    return {
      ...r,
      matchScore,
      matchBreakdown: {
        skillsScore,
        experienceScore,
        locationScore,
        titleScore,
      },
    };
  });
};

/**
 * Get full job details from the appropriate source
 */
const getJobDetails = async (result) => {
  if (result.fullDescription) return result.fullDescription;

  if (result.source === "jobberman" && result.applyUrl) {
    return jobbermanService.getJobDetails(result.applyUrl);
  }

  if (result.source === "indeed" && result.applyUrl) {
    return indeedService.getJobDetails(result.applyUrl);
  }

  // Adzuna results already come with descriptions
  return result.snippet || "";
};

/**
 * Get cached search from DB (< 1 hour old)
 */
const getCachedSearch = async (query, userId) => {
  return JobSearch.findOne({
    userId,
    "query.keywords": query.keywords,
    "query.country": query.country,
    "query.location": query.location,
    cachedUntil: { $gt: new Date() },
  }).sort({ createdAt: -1 });
};

/**
 * Save search results to DB
 */
const saveSearch = async (userId, query, results, sourceCV, source) => {
  return JobSearch.create({
    userId,
    query,
    sourceCV: sourceCV || undefined,
    source,
    results,
    resultCount: results.length,
    cachedUntil: new Date(Date.now() + DB_CACHE_TTL_MS),
  });
};

/**
 * Nigerian-relevant trending job categories
 */
const TRENDING_CATEGORIES = [
  "Graduate Trainee",
  "Software Developer",
  "Customer Service Representative",
  "Banking Officer",
  "Nursing",
  "Data Analyst",
  "Digital Marketing",
  "Administrative Assistant",
  "Sales Executive",
  "Teaching",
  "Engineering",
  "Accounting",
  "Project Manager",
  "Human Resources",
  "Content Writer",
  "Logistics Coordinator",
  "UI UX Designer",
  "Business Development",
  "Pharmacist",
  "Social Media Manager",
];

/**
 * Search trending jobs — picks random categories, fires parallel searches
 */
const searchTrending = async (sourceFilter = "mixed") => {
  const cacheKey = `trending_${sourceFilter}`;

  // Check in-memory cache
  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Pick 4 random categories
  const shuffled = [...TRENDING_CATEGORIES].sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, 4);

  // Fire parallel searches for each category
  const searches = picks.map((keyword) =>
    search(
      { keywords: keyword, location: "", country: "ng", jobType: "", remote: false },
      sourceFilter
    ).catch(() => ({ results: [], count: 0, sources: {} }))
  );

  const results = await Promise.all(searches);

  // Merge all results and deduplicate
  const allResults = results.flatMap((r) => r.results || []);
  const seen = new Set();
  const deduplicated = allResults.filter((r) => {
    const key = `${r.title.toLowerCase()}|${r.company.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Shuffle so it's not grouped by category
  deduplicated.sort(() => Math.random() - 0.5);

  const data = {
    results: deduplicated.slice(0, 50),
    count: deduplicated.length,
    categories: picks,
  };

  // Cache for 30 min
  queryCache.set(cacheKey, { data, timestamp: Date.now() });

  return data;
};

// Clean up expired in-memory cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of queryCache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) {
      queryCache.delete(key);
    }
  }
}, 5 * 60 * 1000);

module.exports = {
  buildSearchQuery,
  search,
  searchTrending,
  scoreResults,
  getJobDetails,
  getCachedSearch,
  saveSearch,
  TRENDING_CATEGORIES,
};
