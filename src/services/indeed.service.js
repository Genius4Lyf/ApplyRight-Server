const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");

const INDEED_BASE_URL = "https://www.indeed.com";
const REQUEST_DELAY_MS = 5000;
let lastRequestTime = 0;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
];

// Indeed uses country-specific domains
const COUNTRY_DOMAINS = {
  us: "www.indeed.com",
  gb: "uk.indeed.com",
  ca: "ca.indeed.com",
  au: "au.indeed.com",
  in: "in.indeed.com",
  ng: "ng.indeed.com",
  za: "za.indeed.com",
  de: "de.indeed.com",
  fr: "fr.indeed.com",
  nl: "nl.indeed.com",
  sg: "sg.indeed.com",
  ae: "ae.indeed.com",
};

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

/**
 * Rate-limited fetch to avoid being blocked
 */
const throttledFetch = async (url) => {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();

  return axios.get(url, {
    headers: {
      "User-Agent": getRandomUA(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control": "max-age=0",
    },
    timeout: 15000,
    maxRedirects: 5,
  });
};

/**
 * Search Indeed for jobs
 */
const searchJobs = async (keywords, location, country = "us", jobType, page = 1) => {
  try {
    const domain = COUNTRY_DOMAINS[country.toLowerCase()] || COUNTRY_DOMAINS.us;
    const params = new URLSearchParams();

    if (keywords) params.set("q", keywords);
    if (location) params.set("l", location);
    if (page > 1) params.set("start", String((page - 1) * 10));

    // Map job types to Indeed format
    if (jobType) {
      const typeMap = {
        fulltime: "fulltime",
        parttime: "parttime",
        contract: "contract",
        internship: "internship",
      };
      if (typeMap[jobType]) params.set("jt", typeMap[jobType]);
    }

    const url = `https://${domain}/jobs?${params.toString()}`;
    const { data } = await throttledFetch(url);
    const $ = cheerio.load(data);

    const results = [];

    // Indeed job card selectors — try multiple patterns for resilience
    const jobCards = $(
      '.job_seen_beacon, .jobsearch-ResultsList .result, .tapItem, [data-jk], .css-1m4cuuf'
    );

    jobCards.each((i, el) => {
      try {
        const $card = $(el);

        // Job key / ID
        const jobKey =
          $card.attr("data-jk") ||
          $card.find("a[data-jk]").attr("data-jk") ||
          $card.find('a[id^="job_"]').attr("id")?.replace("job_", "") ||
          "";

        // Title
        const titleEl = $card.find(
          'h2.jobTitle a, .jobTitle > a, a.jcs-JobTitle, [data-testid="jobTitle"], h2 a'
        ).first();
        const title = titleEl.text().trim();
        if (!title) return; // skip empty

        // URL
        let jobUrl = titleEl.attr("href") || "";
        if (jobUrl && !jobUrl.startsWith("http")) {
          jobUrl = `https://${domain}${jobUrl}`;
        }

        // Company
        const company =
          $card
            .find(
              '[data-testid="company-name"], .companyName, .company_location .companyName, span.css-63koeb'
            )
            .first()
            .text()
            .trim() || "Unknown Company";

        // Location
        const locationText =
          $card
            .find(
              '[data-testid="text-location"], .companyLocation, .company_location .companyLocation, div.css-1p0sjhy'
            )
            .first()
            .text()
            .trim() || "";

        // Salary
        const salary =
          $card
            .find(
              '.salary-snippet-container, .salaryText, [data-testid="attribute_snippet_testid"], .css-1blakes .attribute_snippet'
            )
            .first()
            .text()
            .trim() || "";

        // Snippet
        const snippet =
          $card
            .find(
              '.job-snippet, .underShelfFooter, [data-testid="jobDescriptionText"], .css-9446fg'
            )
            .first()
            .text()
            .trim() || "";

        // Date
        const dateText =
          $card
            .find('.date, .myJobsStateDate, span.css-qvloho')
            .first()
            .text()
            .trim() || "";

        const externalId =
          jobKey ||
          crypto
            .createHash("md5")
            .update(jobUrl || title + company)
            .digest("hex")
            .substring(0, 16);

        results.push({
          externalId,
          source: "indeed",
          title,
          company,
          location: locationText,
          salary,
          snippet: snippet.substring(0, 200),
          fullDescription: "",
          applyUrl: jobUrl,
          category: "",
          postedDate: parseDateText(dateText),
        });
      } catch (e) {
        // Skip malformed cards
      }
    });

    return { results, count: results.length };
  } catch (error) {
    console.error("Indeed scraper error:", error.message);
    return { results: [], count: 0 };
  }
};

/**
 * Get full job description from an Indeed listing page
 */
const getJobDetails = async (url) => {
  try {
    const { data } = await throttledFetch(url);
    const $ = cheerio.load(data);

    const description =
      $(
        '#jobDescriptionText, .jobsearch-jobDescriptionText, [data-testid="jobDescriptionText"], .job-description'
      )
        .first()
        .text()
        .trim() || $("article").first().text().trim() || "";

    return description.replace(/\s+/g, " ").trim();
  } catch (error) {
    console.error("Indeed detail fetch error:", error.message);
    return "";
  }
};

/**
 * Parse relative date strings like "3 days ago", "Just posted", "Today"
 */
const parseDateText = (text) => {
  if (!text) return new Date();
  const lower = text.toLowerCase();
  const now = new Date();

  const match = lower.match(/(\d+)\s*(min|hour|day|week|month)/);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2];
    const ms = {
      min: 60 * 1000,
      hour: 3600 * 1000,
      day: 86400 * 1000,
      week: 7 * 86400 * 1000,
      month: 30 * 86400 * 1000,
    };
    return new Date(now.getTime() - num * (ms[unit] || 0));
  }

  if (lower.includes("just posted") || lower.includes("today") || lower.includes("just now"))
    return now;
  if (lower.includes("yesterday")) return new Date(now.getTime() - 86400 * 1000);

  return now;
};

module.exports = {
  searchJobs,
  getJobDetails,
  COUNTRY_DOMAINS,
};
