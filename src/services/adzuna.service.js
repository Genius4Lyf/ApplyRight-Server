const axios = require("axios");

const ADZUNA_BASE_URL = "https://api.adzuna.com/v1/api";

const SUPPORTED_COUNTRIES = [
  "us", "gb", "ca", "au", "de", "fr", "in", "nl", "br", "pl", "ru", "za",
];

const getCredentials = () => ({
  app_id: process.env.ADZUNA_APP_ID || "",
  app_key: process.env.ADZUNA_APP_KEY || "",
});

const isConfigured = () => {
  const { app_id, app_key } = getCredentials();
  return !!(app_id && app_key);
};

/**
 * Search jobs on Adzuna API
 */
const searchJobs = async (keywords, location, country = "gb", jobType, page = 1) => {
  if (!isConfigured()) {
    console.warn("Adzuna API not configured — returning empty results");
    return { results: [], count: 0 };
  }

  const countryCode = SUPPORTED_COUNTRIES.includes(country.toLowerCase())
    ? country.toLowerCase()
    : "gb";

  const { app_id, app_key } = getCredentials();

  const params = {
    app_id,
    app_key,
    results_per_page: 30,
    what: keywords,
  };

  if (location) params.where = location;

  // Map job types to Adzuna format
  if (jobType) {
    const typeMap = {
      fulltime: "full_time",
      parttime: "part_time",
      contract: "contract",
      // Adzuna has no internship type — skip it so results aren't narrowed to permanent roles
    };
    if (typeMap[jobType]) params[typeMap[jobType]] = 1;
  }

  try {
    const response = await axios.get(
      `${ADZUNA_BASE_URL}/jobs/${countryCode}/search/${page}`,
      { params, timeout: 10000 }
    );

    const data = response.data;
    return {
      results: (data.results || []).map(normalizeAdzunaResult),
      count: data.count || 0,
    };
  } catch (error) {
    console.error("Adzuna API error:", error.message);
    return { results: [], count: 0 };
  }
};

/**
 * Normalize an Adzuna result to our unified format
 */
const normalizeAdzunaResult = (job) => {
  let salary = "";
  if (job.salary_min && job.salary_max) {
    const currency = job.salary_is_predicted ? "~" : "";
    salary = `${currency}${formatSalary(job.salary_min)} - ${formatSalary(job.salary_max)}`;
  } else if (job.salary_min) {
    salary = `From ${formatSalary(job.salary_min)}`;
  }

  return {
    externalId: String(job.id),
    source: "adzuna",
    title: job.title || "Untitled",
    company: job.company?.display_name || "Unknown Company",
    location: job.location?.display_name || "",
    salary,
    snippet: job.description ? job.description.substring(0, 200) + "..." : "",
    fullDescription: job.description || "",
    applyUrl: job.redirect_url || "", // preserve tracking params!
    category: job.category?.label || "",
    postedDate: job.created ? new Date(job.created) : new Date(),
  };
};

const formatSalary = (amount) => {
  if (amount >= 1000) {
    return `${Math.round(amount / 1000)}K`;
  }
  return String(amount);
};

/**
 * Get available job categories for a country
 */
const getCategories = async (country = "gb") => {
  if (!isConfigured()) return [];

  const countryCode = SUPPORTED_COUNTRIES.includes(country.toLowerCase())
    ? country.toLowerCase()
    : "gb";
  const { app_id, app_key } = getCredentials();

  try {
    const response = await axios.get(
      `${ADZUNA_BASE_URL}/jobs/${countryCode}/categories`,
      { params: { app_id, app_key }, timeout: 5000 }
    );
    return response.data.results || [];
  } catch (error) {
    console.error("Adzuna categories error:", error.message);
    return [];
  }
};

module.exports = {
  searchJobs,
  getCategories,
  isConfigured,
  SUPPORTED_COUNTRIES,
};
