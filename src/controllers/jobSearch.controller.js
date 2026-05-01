const jobSearchService = require("../services/jobSearch.service");
const JobSearch = require("../models/JobSearch");

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
// @access  Public
const searchJobs = async (req, res) => {
  try {
    const { keywords, location, country, jobType, remote, source, page, limit } = req.body;

    const query = jobSearchService.buildSearchQuery({
      keywords,
      location,
      country,
      jobType,
      remote,
    });

    if (!query.keywords) {
      return res.status(400).json({ message: "Please provide search keywords" });
    }

    const sourceFilter = source || "mixed";

    const cached = await jobSearchService.getCachedSearch(query, sourceFilter);
    if (cached) {
      const paged = paginate(cached.results || [], page, limit);
      return res.json({ _id: cached._id, searchId: cached._id, ...paged });
    }

    const searchData = await jobSearchService.search(query, sourceFilter);

    const saved = await jobSearchService.saveSearch(query, searchData.results, sourceFilter);

    const paged = paginate(searchData.results, page, limit);
    res.json({ _id: saved._id, searchId: saved._id, ...paged });
  } catch (error) {
    console.error("Job search error:", error.message);
    res.status(500).json({ message: "Failed to search jobs" });
  }
};

// @desc    Get trending jobs
// @route   GET /api/job-search/trending
// @access  Public
const getTrendingJobs = async (req, res) => {
  try {
    const { source, page, limit } = req.query;
    const sourceFilter = source || "mixed";

    const query = { keywords: "trending", location: "", country: "ng", jobType: "", remote: false };
    const cached = await jobSearchService.getCachedSearch(query, sourceFilter);
    if (cached) {
      const filteredResults = filterBySource(cached.results || [], sourceFilter);
      const paged = paginate(filteredResults, page, limit);
      return res.json({ _id: cached._id, searchId: cached._id, ...paged, categories: [] });
    }

    const data = await jobSearchService.searchTrending(sourceFilter);

    const saved = await jobSearchService.saveSearch(query, data.results || [], sourceFilter);

    const paged = paginate(data.results || [], page, limit);
    res.json({ _id: saved._id, searchId: saved._id, ...paged, categories: data.categories });
  } catch (error) {
    console.error("Trending jobs error:", error.message);
    res.status(500).json({ message: "Failed to load trending jobs" });
  }
};

// @desc    Browse jobs by source
// @route   GET /api/job-search/browse
// @access  Public
const browseJobs = async (req, res) => {
  try {
    const { source, page, limit } = req.query;
    const sourceFilter = source || "mixed";

    const query = { keywords: "jobs", location: "", country: "ng", jobType: "", remote: false };

    const cached = await jobSearchService.getCachedSearch(query, sourceFilter);
    if (cached) {
      const filteredResults = filterBySource(cached.results || [], sourceFilter);
      const paged = paginate(filteredResults, page, limit);
      return res.json({ _id: cached._id, searchId: cached._id, ...paged });
    }

    const data = await jobSearchService.search(query, sourceFilter);

    const saved = await jobSearchService.saveSearch(query, data.results || [], sourceFilter);

    const paged = paginate(data.results || [], page, limit);
    res.json({ _id: saved._id, searchId: saved._id, ...paged });
  } catch (error) {
    console.error("Browse jobs error:", error.message);
    res.status(500).json({ message: "Failed to browse jobs" });
  }
};

// @desc    Get cached search results
// @route   GET /api/job-search/search/:searchId
// @access  Public
const getSearchResults = async (req, res) => {
  try {
    const search = await JobSearch.findById(req.params.searchId);

    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    res.json(search);
  } catch (error) {
    console.error("Get search error:", error.message);
    res.status(500).json({ message: "Failed to get search results" });
  }
};

// @desc    Get full job description
// @route   POST /api/job-search/:searchId/details/:resultId
// @access  Public
const getJobDetails = async (req, res) => {
  try {
    const { searchId, resultId } = req.params;

    const search = await JobSearch.findById(searchId);
    if (!search) {
      return res.status(404).json({ message: "Search not found" });
    }

    const result = search.results.id(resultId);
    if (!result) {
      return res.status(404).json({ message: "Job result not found" });
    }

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
// @access  Public
const trackClick = async (req, res) => {
  try {
    const { searchId, resultId } = req.params;

    const search = await JobSearch.findById(searchId);
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

module.exports = {
  searchJobs,
  getSearchResults,
  getTrendingJobs,
  browseJobs,
  getJobDetails,
  trackClick,
};
