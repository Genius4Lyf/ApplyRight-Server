const jobbermanService = require("./jobberman.service");
const JobSearch = require("../models/JobSearch");

// ADZUNA IS GONE (2026-09-08). It was the "global" half of this aggregator and it never
// worked for the audience this product has: Adzuna publishes no Nigeria index at all —
// `ng` and `nga` both 404 UNSUPPORTED_COUNTRY — so the code quietly routed every
// Nigerian query to the UNITED KINGDOM index with the location blanked, and showed the
// results as if they were local. A user in Lagos was being offered jobs in Manchester.
//
// Jobberman is now the only source, which makes job search NIGERIA-ONLY. That is the
// deliberate trade: honest coverage of one market beats fake coverage of several. A
// non-NG user gets an empty list, and should be told so rather than shown the wrong
// country.
//
// Cached rows written before this change still hold Adzuna results, so RETIRED_SOURCES
// strips them on the way out. Without it the UK listings would keep being served for up
// to an hour after deploy, which is the exact bug this removes.
const RETIRED_SOURCES = new Set(["adzuna"]);
const withoutRetiredSources = (results = []) =>
  results.filter((r) => !RETIRED_SOURCES.has(r?.source));

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
 * Search jobs from Jobberman.
 *
 * `sourceFilter` no longer selects anything — there is one board — but it stays in the
 * cache key and on the saved record, because it is what a second source would key off
 * when one is added.
 */
const search = async (query, sourceFilter = "mixed") => {
  const cacheKey = JSON.stringify({ ...query, sourceFilter });

  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const jobberman = await jobbermanService
    .searchJobs(query.keywords, query.location, query.jobType)
    .catch(() => ({ results: [], count: 0 }));

  const allResults = jobberman.results || [];

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
    // Kept as a map rather than a number: the caller reads it per source, and it is
    // where a second board would appear.
    sources: { jobberman: allResults.length },
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
 *
 * Returns a PLAIN object with retired-source results already stripped, so a row cached
 * before Adzuna was removed cannot keep serving UK listings to Nigerian users. The rows
 * themselves are left alone — `getJobDetails` and `trackClick` still save them by id,
 * and rewriting history to tidy a cache is not worth a 500 on somebody's apply click.
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
  const found = await JobSearch.findOne(filter).sort({ createdAt: -1 }).lean();
  if (!found) return null;
  return { ...found, results: withoutRetiredSources(found.results) };
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

// Sweeps expired entries out of the in-memory cache.
//
// `.unref()` because this timer is created at REQUIRE time — app.js mounts the route,
// which pulls in the controller, which pulls in this file — and an active timer keeps
// Node's event loop alive forever. It is the only module-level timer in the backend.
// Measured: before this, `node -e "require(./jobSearch.service)"` never exited; now it
// returns immediately.
//
// It is NOT, as first assumed, the reason `npm test` warns about a worker failing to
// exit gracefully — that warning survives this fix, and `--detectOpenHandles` (which
// runs in band) reports no open handles at all. That one is a worker-pool teardown
// artifact, and still unexplained.
//
// unref does not stop the sweep. While the server is running there is always a live
// listener, so the loop stays alive and the interval fires exactly as before; it only
// stops being a REASON for the loop to stay alive once everything else is done.
const cacheSweeper = setInterval(
  () => {
    const now = Date.now();
    for (const [key, value] of queryCache.entries()) {
      if (now - value.timestamp > CACHE_TTL_MS) {
        queryCache.delete(key);
      }
    }
  },
  5 * 60 * 1000
);
cacheSweeper.unref();

module.exports = {
  buildSearchQuery,
  search,
  searchTrending,
  getJobDetails,
  getCachedSearch,
  saveSearch,
  TRENDING_CATEGORIES,
};
