const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");

const JOBBERMAN_BASE_URL = "https://www.jobberman.com";
// Spacing between outbound requests. Overridable so the throttle can be tuned against
// how Jobberman actually behaves without a deploy — and so the suite can exercise the
// queue in milliseconds instead of sitting through real five-second gaps.
const REQUEST_DELAY_MS = Number(process.env.JOBBERMAN_DELAY_MS) || 5000;
let lastRequestTime = 0;

// One shared queue for every caller, and a hard cap on how deep it may get.
//
// This scraper talks to somebody else's site on borrowed goodwill, so the 5s spacing
// is the whole reason we are tolerated. Four slots is ~20s of waiting at the back of
// the queue, which is already at the edge of what a user will sit through; past that
// it is kinder to fail fast and let jobSearch.service use its other sources than to
// hold an HTTP request open for a minute.
const MAX_QUEUED = 4;
let fetchChain = Promise.resolve();
let queueDepth = 0;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

/**
 * Rate-limited fetch to avoid being blocked.
 *
 * This used to read `lastRequestTime`, await the remainder of the interval, and only
 * then write it back. With one caller that works. With two it throttles NOTHING: both
 * read the same timestamp, both compute the same wait, both sleep, and both fire in
 * the same millisecond — precisely the burst the delay exists to prevent, and exactly
 * the traffic pattern that gets a scraper blocked. It only ever looked correct because
 * nothing was calling it concurrently yet.
 *
 * Requests are now serialised through a promise chain, so N callers wait N intervals
 * instead of none. The chain is the same shape as the send gate in utils/email.service,
 * which had the identical defect for the identical reason.
 */
const throttledFetch = (url) => {
  if (queueDepth >= MAX_QUEUED) {
    // searchJobs turns this into an empty result set and getJobDetails into an empty
    // description, both of which the callers already handle.
    return Promise.reject(new Error("Jobberman is busy; too many queued requests"));
  }
  queueDepth += 1;

  const run = async () => {
    const elapsed = Date.now() - lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
    }
    lastRequestTime = Date.now();

    return axios.get(url, {
      headers: {
        "User-Agent": getRandomUA(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
      maxRedirects: 5,
    });
  };

  // `then(run, run)` so one failed fetch does not stall every request behind it.
  const result = fetchChain.then(run, run).finally(() => {
    queueDepth -= 1;
  });

  // The chain only needs the timing, and must never carry a rejection nobody handles —
  // the caller owns `result` and its error.
  fetchChain = result.then(
    () => {},
    () => {}
  );

  return result;
};

/**
 * Search Jobberman for Nigerian jobs
 */
const searchJobs = async (keywords, location, jobType, page = 1) => {
  try {
    const params = new URLSearchParams();
    if (keywords) params.set("q", keywords);
    if (location) params.set("l", location);
    if (page > 1) params.set("page", String(page));

    // Map job types
    if (jobType) {
      const typeMap = {
        fulltime: "Full-time",
        parttime: "Part-time",
        contract: "Contract",
        internship: "Internship",
      };
      if (typeMap[jobType]) params.set("work_type", typeMap[jobType]);
    }

    const url = `${JOBBERMAN_BASE_URL}/jobs?${params.toString()}`;
    const { data } = await throttledFetch(url);
    const $ = cheerio.load(data);

    const results = [];

    // Jobberman renders each job card inside [data-cy="listing-cards-components"]
    const jobCards = $('[data-cy="listing-cards-components"]');

    jobCards.each((i, el) => {
      try {
        const $card = $(el);

        // Title: <a data-cy="listing-title-link"> > <p class="text-lg ...">
        const titleEl = $card.find('[data-cy="listing-title-link"], a[href*="/listings/"]').first();
        const title = titleEl.find("p.text-lg").text().trim() || titleEl.text().trim();
        if (!title) return;

        // URL
        let jobUrl = titleEl.attr("href") || "";
        if (jobUrl && !jobUrl.startsWith("http")) {
          jobUrl = JOBBERMAN_BASE_URL + jobUrl;
        }

        // Company: <p class="text-sm text-blue-700"> — may or may not have nested <a>
        const company =
          $card.find("p.text-sm.text-blue-700").first().text().trim() ||
          $card.find("p.text-sm.text-link-500").first().text().trim() ||
          "Unknown Company";

        // Location & job type & salary from the tag spans
        const tags = [];
        $card.find("span.rounded.bg-brand-secondary-100, span[class*='bg-brand-secondary']").each((j, span) => {
          tags.push($(span).text().trim());
        });

        // First tag is usually location, second is job type, third might be salary
        let locationText = "Nigeria";
        let salary = "";
        for (const tag of tags) {
          if (/NGN|USD|\d{3},\d{3}/.test(tag)) {
            salary = tag;
          } else if (!locationText || locationText === "Nigeria") {
            // First non-salary tag is location
            if (!["Full Time", "Part Time", "Contract", "Internship", "Remote"].includes(tag)) {
              locationText = tag;
            }
          }
        }

        // Category (e.g. "Software & Data", "Marketing & Communications")
        const category = $card.find("p.text-sm.text-gray-500.inline-block").first().text().trim() || "";

        // Snippet — job description preview text
        const snippetText = $card.find("p.text-sm.text-gray-700.md\\:text-gray-500, p.font-normal.text-gray-700.md\\:text-gray-500").first().text().trim() || "";

        // Posted date
        const dateText = $card.find("p.font-normal.text-gray-700.text-loading-animate").first().text().trim() || "";

        const externalId = crypto.createHash("md5").update(jobUrl || title + company).digest("hex").substring(0, 16);

        results.push({
          externalId,
          source: "jobberman",
          title,
          company,
          location: locationText,
          salary,
          snippet: (snippetText || category).substring(0, 200),
          fullDescription: "",
          applyUrl: jobUrl,
          category,
          postedDate: parseDateText(dateText),
        });
      } catch (e) {
        // Skip malformed cards
      }
    });

    return { results, count: results.length };
  } catch (error) {
    console.error("Jobberman scraper error:", error.message);
    return { results: [], count: 0 };
  }
};

/**
 * Get full job description from a Jobberman listing page
 * Preserves HTML structure for proper frontend formatting
 */
const getJobDetails = async (url) => {
  try {
    const { data } = await throttledFetch(url);
    const $ = cheerio.load(data);

    // Try to get the HTML content (preserving structure)
    const descEl = $('[data-cy="job-description"], .job-description, article .prose, .job-details__description').first();

    const cleanJobHtml = (el) => {
      // Remove script/style tags, inputs, and SVGs/images to prevent massive broken icons
      el.find('script, style, iframe, form, input, button, object, embed, svg, img').remove();
      
      // Remove Jobberman specific share/report links
      el.find('a[href*="whatsapp"], a[href*="linkedin"], a[href*="facebook"], a[href*="twitter"], a[href*="x.com"]').parent().remove();
      el.find('a[href*="/report"], a:contains("Report Job")').closest('div, p').remove();
      
      // Remove empty tags
      el.find('p, div, span').filter(function() {
        return $(this).text().trim() === '' && $(this).children().length === 0;
      }).remove();
    };

    if (descEl.length) {
      cleanJobHtml(descEl);
      const html = descEl.html();
      if (html && html.trim()) return html.trim();
    }

    // Fallback: try article
    const articleEl = $('article').first();
    if (articleEl.length) {
      cleanJobHtml(articleEl);
      const html = articleEl.html();
      if (html && html.trim()) return html.trim();
    }

    return "";
  } catch (error) {
    console.error("Jobberman detail fetch error:", error.message);
    return "";
  }
};

/**
 * Parse relative date strings like "2 days ago", "1 week ago"
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

  if (lower.includes("today") || lower.includes("just now")) return now;
  if (lower.includes("yesterday")) return new Date(now.getTime() - 86400 * 1000);

  return now;
};

module.exports = {
  searchJobs,
  getJobDetails,
};
