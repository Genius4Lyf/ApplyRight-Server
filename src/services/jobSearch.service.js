const adzunaService = require("./adzuna.service");
const jobbermanService = require("./jobberman.service");
const JobSearch = require("../models/JobSearch");

// In-memory cache for hot queries (TTL: 30 minutes)
const queryCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const DB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for DB cache

/**
 * Build a search query from request overrides
 */
const buildSearchQuery = (overrides = {}) => {
  const keywords = (overrides.keywords || "").trim();
  const location = (overrides.location || "").trim();
  const country = (overrides.country || "").trim() || "ng";
  const jobType = overrides.jobType || "";
  const remote = overrides.remote || false;

  return { keywords, location, country, jobType, remote };
};

/**
 * Search jobs from Adzuna and Jobberman
 */
const search = async (query, sourceFilter = "mixed") => {
  const cacheKey = JSON.stringify({ ...query, sourceFilter });

  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const isNigeria = query.country.toLowerCase() === "ng";
  const isGlobal = sourceFilter === "global";
  const isLocal = sourceFilter === "local";
  const isMixed = sourceFilter === "mixed";

  const sourcePromises = {};

  if (isMixed || isGlobal || sourceFilter === "adzuna") {
    const adzunaCountry = isNigeria ? "gb" : query.country;
    const adzunaKeywords = query.remote ? `${query.keywords} remote` : query.keywords;
    const adzunaLocation = (query.remote || isNigeria) ? "" : query.location;
    sourcePromises.adzuna = adzunaService
      .searchJobs(adzunaKeywords, adzunaLocation, adzunaCountry, query.jobType)
      .catch(() => ({ results: [], count: 0 }));
  }

  if (isMixed || isLocal || sourceFilter === "jobberman") {
    sourcePromises.jobberman = jobbermanService
      .searchJobs(query.keywords, query.location, query.jobType)
      .catch(() => ({ results: [], count: 0 }));
  }

  const keys = Object.keys(sourcePromises);
  const values = await Promise.all(Object.values(sourcePromises));
  const sourceData = {};
  keys.forEach((key, i) => {
    sourceData[key] = values[i];
  });

  const allResults = [
    ...(sourceData.adzuna?.results || []),
    ...(sourceData.jobberman?.results || []),
  ];

  const seen = new Set();
  const deduplicated = allResults.filter((r) => {
    const key = `${r.title.toLowerCase()}|${r.company.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduplicated.sort((a, b) => new Date(b.postedDate) - new Date(a.postedDate));

  const result = {
    results: deduplicated,
    count: deduplicated.length,
    sources: {
      adzuna: sourceData.adzuna?.results?.length || 0,
      jobberman: sourceData.jobberman?.results?.length || 0,
    },
  };

  queryCache.set(cacheKey, { data: result, timestamp: Date.now() });

  return result;
};

/**
 * Get full job details from the appropriate source
 */
const getJobDetails = async (result) => {
  if (result.fullDescription) return result.fullDescription;

  if (result.source === "jobberman" && result.applyUrl) {
    return jobbermanService.getJobDetails(result.applyUrl);
  }

  return result.snippet || "";
};

/**
 * Get a cached search from DB (< 1 hour old). Shared across all visitors.
 */
const getCachedSearch = async (query, source) => {
  const filter = {
    "query.keywords": query.keywords,
    "query.country": query.country,
    "query.location": query.location,
    "query.jobType": query.jobType || "",
    "query.remote": query.remote || false,
    cachedUntil: { $gt: new Date() },
  };
  if (source) {
    filter.source = source;
  }
  return JobSearch.findOne(filter).sort({ createdAt: -1 });
};

/**
 * Save search results to DB
 */
const saveSearch = async (query, results, source) => {
  return JobSearch.create({
    query,
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

  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const shuffled = [...TRENDING_CATEGORIES].sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, 4);

  const searches = picks.map((keyword) =>
    search(
      { keywords: keyword, location: "", country: "ng", jobType: "", remote: false },
      sourceFilter
    ).catch(() => ({ results: [], count: 0, sources: {} }))
  );

  const results = await Promise.all(searches);

  const allResults = results.flatMap((r) => r.results || []);
  const seen = new Set();
  const deduplicated = allResults.filter((r) => {
    const key = `${r.title.toLowerCase()}|${r.company.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduplicated.sort(() => Math.random() - 0.5);

  const data = {
    results: deduplicated.slice(0, 50),
    count: deduplicated.length,
    categories: picks,
  };

  queryCache.set(cacheKey, { data, timestamp: Date.now() });

  return data;
};

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
  getJobDetails,
  getCachedSearch,
  saveSearch,
  TRENDING_CATEGORIES,
};
