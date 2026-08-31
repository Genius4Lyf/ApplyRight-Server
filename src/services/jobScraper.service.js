const axios = require("axios");
const cheerio = require("cheerio");
const { htmlToMarkdown, decodeEntities } = require("./htmlToMarkdown.service");

// Reading a job posting from its URL.
//
// THE ORDER OF PREFERENCE IS THE WHOLE DESIGN. A good posting publishes a Schema.org
// `JobPosting` block — a JSON object the site writes FOR machines, carrying salary,
// location, employment type and dates alongside the description. That is not scraping;
// it is the site handing us the posting. Everything below it is a fallback, and each
// fallback knows less than the one above:
//
//   1. JSON-LD JobPosting  → the posting itself, all fields, description as HTML.
//   2. DOM containers      → the description only, and only if we guess the right box.
//   3. og:description      → a SUMMARY. Never the job description, however long it is.
//
// Level 3 used to be silently promoted to "the job description" whenever it cleared 200
// characters, which meant an analysis could run against a two-line teaser with nobody
// told. It is now returned with `quality: 'teaser'` so the caller can say so.

// Below this, a description is a blurb rather than a posting. Real JDs run to thousands
// of characters; the shortest genuine ones still clear this comfortably.
const FULL_DESCRIPTION_CHARS = 400;

// A page that answered, but with a challenge instead of a posting.
const BOT_WALL_PATTERNS = [
  /please verify you('?| a)re? human/i,
  /are you a robot/i,
  /just a moment\.\.\./i, // Cloudflare interstitial
  /please enable javascript/i,
  /enable cookies to continue/i,
  /access denied/i,
  /captcha/i,
  /unusual traffic from your/i,
];

// ── Schema.org helpers ───────────────────────────────────────────────────────
//
// Every one of these tolerates the field being absent, a string, an object, or an array
// of either — real postings are inconsistent in all four ways, and a throw here would
// lose a posting we had already successfully fetched.

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// Trimmed AND decoded. JSON-LD values are plain strings that never meet an HTML parser,
// and postings routinely encode their own text before writing it there — so "&amp;"
// reaches the screen intact unless it is decoded here.
const text = (v) => (typeof v === "string" ? decodeEntities(v).trim() : "");

const typesOf = (node) => asArray(node && node["@type"]).map((t) => String(t).toLowerCase());

/**
 * Find the JobPosting node in a page's JSON-LD.
 *
 * Sites nest it in three shapes: bare, inside an `@graph` array, or as one entry of a
 * top-level array. All three are common enough that missing any of them loses postings.
 */
const findJobPosting = ($) => {
  let found = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return false;
    let parsed;
    try {
      parsed = JSON.parse($(el).html());
    } catch {
      return undefined; // malformed block — try the next one
    }
    const candidates = [...asArray(parsed), ...asArray(parsed && parsed["@graph"]).flat()];
    for (const node of candidates) {
      if (node && typesOf(node).includes("jobposting")) {
        found = node;
        return false;
      }
    }
    return undefined;
  });
  return found;
};

/** "Lagos, Lagos State, NG" — as much of the address as the posting actually gave. */
const readLocation = (posting) => {
  if (String(posting.jobLocationType || "").toUpperCase() === "TELECOMMUTE") return "Remote";
  const place = asArray(posting.jobLocation)[0];
  const address = place && (place.address || place);
  if (!address) return "";
  const parts = [
    text(address.addressLocality),
    text(address.addressRegion),
    text(address.addressCountry) || text(address.addressCountry && address.addressCountry.name),
  ].filter(Boolean);
  return [...new Set(parts)].join(", ");
};

/** "NGN 400,000–600,000 per MONTH", or as much of it as the posting stated. */
const readSalary = (posting) => {
  const base = posting.baseSalary;
  if (!base) return "";
  const currency = text(base.currency) || text(base.currencyCode) || "";
  const value = base.value || base;
  const min = value.minValue ?? value.value;
  const max = value.maxValue;
  if (min == null && max == null) return "";
  const num = (n) => Number(n).toLocaleString("en-US");
  const range = max != null && max !== min ? `${num(min)}–${num(max)}` : num(min ?? max);
  const unit = text(value.unitText);
  return [currency, range, unit && `per ${unit}`].filter(Boolean).join(" ").trim();
};

/**
 * Everything the posting stated about itself beyond its text. Absent fields are omitted
 * rather than stored empty, so "we don't know" and "not stated" stay distinguishable.
 */
const readDetails = (posting) => {
  const details = {
    location: readLocation(posting),
    employmentType: asArray(posting.employmentType).map(text).filter(Boolean).join(", "),
    salary: readSalary(posting),
    datePosted: text(posting.datePosted),
    validThrough: text(posting.validThrough),
    experienceRequirements: text(
      typeof posting.experienceRequirements === "object"
        ? posting.experienceRequirements &&
            (posting.experienceRequirements.description ||
              posting.experienceRequirements.monthsOfExperience)
        : posting.experienceRequirements
    ),
    educationRequirements: text(
      typeof posting.educationRequirements === "object"
        ? posting.educationRequirements && posting.educationRequirements.credentialCategory
        : posting.educationRequirements
    ),
    industry: asArray(posting.industry).map(text).filter(Boolean).join(", "),
  };
  return Object.fromEntries(Object.entries(details).filter(([, v]) => v));
};

// ── DOM fallbacks ────────────────────────────────────────────────────────────

// Ordered most specific first. Each is a container some ATS is known to use.
const DESCRIPTION_SELECTORS = [
  "#job-details",
  ".job-description",
  '[data-testid="job-description"]',
  '[data-cy="job-description"]',
  ".description__text",
  ".show-more-less-html__markup", // LinkedIn
  ".posting-page", // Lever
  ".job-details",
  ".posting-requirements",
  "article",
];

const COMPANY_SELECTORS = [
  ".company-name",
  ".job-company",
  "[data-company]",
  ".hiring-organization",
  ".top-card-layout__first-subline-link", // LinkedIn
  '[data-testid="company-name"]',
];

/**
 * Read a job posting from a URL.
 *
 * @param {string} url
 * @returns {Promise<{
 *   title: string, company: string, description: string, jobUrl: string,
 *   source: 'structured'|'dom'|'meta',
 *   quality: 'full'|'teaser',
 *   details: object
 * }>}
 * @throws {Error} ACCESS_DENIED — blocked, timed out, or nothing readable came back.
 *                 JOB_NOT_FOUND — the posting is gone.
 */
const scrapeJob = async (url) => {
  try {
    const { data, request } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
      maxRedirects: 5, // Follow shortened URLs (lnkd.in, bit.ly, etc.)
    });

    const finalUrl = request?.res?.responseUrl || url;
    const $ = cheerio.load(data);

    // ── Level 1: the posting's own structured data ──
    const posting = findJobPosting($) || {};
    const details = readDetails(posting);

    let title = text(posting.title);
    let company = text(posting.hiringOrganization && posting.hiringOrganization.name);
    let description = "";
    let source = "";

    if (posting.description) {
      // Nearly always HTML, and that markup IS the posting's structure — its headings and
      // its requirement bullets. Converted, not stripped.
      description = htmlToMarkdown(posting.description);
      source = "structured";
    }

    // ── Level 2: the DOM ──
    if (!title) title = $("h1").first().text().trim() || $("title").text().trim();

    if (!company) {
      company =
        $('meta[property="og:site_name"]').attr("content") ||
        $('meta[name="twitter:site"]').attr("content") ||
        $('meta[name="author"]').attr("content") ||
        "";
    }
    if (!company) {
      for (const selector of COMPANY_SELECTORS) {
        if ($(selector).length > 0) {
          company = $(selector).first().text().trim();
          break;
        }
      }
    }
    // Title parsing fallback: "Role at Company" or "Role - Company".
    if (!company && title.includes(" at ")) {
      company = title.split(" at ").pop().trim();
    } else if (!company && title.includes(" - ")) {
      company = title.split(" - ").pop().trim();
    }
    if (!company) company = "Unknown Company";

    if (description.length < FULL_DESCRIPTION_CHARS) {
      for (const selector of DESCRIPTION_SELECTORS) {
        const node = $(selector).first();
        if (node.length === 0) continue;
        // .html(), not .text(): the same reason as the structured branch above.
        const converted = htmlToMarkdown(node.html());
        if (converted.length > description.length) {
          description = converted;
          source = "dom";
        }
        if (description.length >= FULL_DESCRIPTION_CHARS) break;
      }
    }

    // ── Level 3: the summary meta tags ──
    //
    // Taken ONLY when the levels above found nothing better, and never promoted to a full
    // description however long it is — og:description is a summary by definition.
    if (description.length < FULL_DESCRIPTION_CHARS) {
      const metaDesc = (
        $('meta[property="og:description"]').attr("content") ||
        $('meta[name="description"]').attr("content") ||
        $('meta[name="twitter:description"]').attr("content") ||
        ""
      ).trim();
      if (metaDesc.length > description.length) {
        description = metaDesc;
        source = "meta";
      }
    }

    // The DOM paths above are already decoded by cheerio; this catches a title that came
    // from JSON-LD via a route that skipped `text()`, and is a no-op otherwise.
    title = decodeEntities(title);
    company = decodeEntities(company);

    // Clean up the title's page-title suffix: "Senior Engineer | LinkedIn" → "Senior Engineer"
    for (const sep of [" | ", " — ", " :: ", " - "]) {
      if (title.includes(sep)) {
        title = title.split(sep)[0].trim();
        break;
      }
    }

    // ── What did we actually get? ──
    const looksLikeBotWall = BOT_WALL_PATTERNS.some((re) => re.test(description));
    if (looksLikeBotWall || description.length < 100) {
      console.error(
        `Scraping returned thin/blocked content for ${url} (len=${description.length}, botWall=${looksLikeBotWall})`
      );
      throw new Error("ACCESS_DENIED");
    }

    // A summary is a summary. Saying so is the whole point of grading this: the caller
    // offers the user a way to fill the gap instead of analysing a blurb in silence.
    const quality =
      source !== "meta" && description.length >= FULL_DESCRIPTION_CHARS ? "full" : "teaser";

    return {
      title,
      company,
      description,
      jobUrl: finalUrl,
      source: source || "dom",
      quality,
      details,
    };
  } catch (error) {
    if (error.message === "ACCESS_DENIED" || error.message === "JOB_NOT_FOUND") throw error;
    if (error.code === "ECONNABORTED") {
      console.error("Scraping timed out for:", url);
      throw new Error("ACCESS_DENIED");
    }
    if (error.response) {
      if (error.response.status === 403 || error.response.status === 401) {
        console.error("Scraping Access Denied:", error.response.status);
        throw new Error("ACCESS_DENIED");
      }
      if (error.response.status === 404) {
        throw new Error("JOB_NOT_FOUND");
      }
    }
    console.error("Scraping Error:", error.message);
    throw new Error("Failed to scrape job details");
  }
};

module.exports = { scrapeJob, FULL_DESCRIPTION_CHARS };
