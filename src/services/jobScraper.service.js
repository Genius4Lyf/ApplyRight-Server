const axios = require("axios");
const cheerio = require("cheerio");

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
      timeout: 15000, // 15 second timeout
      maxRedirects: 5, // Follow shortened URLs (lnkd.in, bit.ly, etc.)
    });

    // Use the final URL after redirects
    const finalUrl = request?.res?.responseUrl || url;

    const $ = cheerio.load(data);

    // ── Title Extraction ──
    let title = "";

    // Try structured data first (most reliable)
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json["@type"] === "JobPosting" && json.title) {
          title = json.title;
          return false; // break
        }
      } catch (e) {
        // skip malformed JSON
      }
    });

    // Fall back to H1, then <title>
    if (!title) {
      title = $("h1").first().text().trim() || $("title").text().trim();
    }

    // ── Company Extraction ──
    let company = "";

    // 1. JSON-LD (Schema.org) — most reliable source
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        const org = json.hiringOrganization || json.author || json.publisher;
        if (org && org.name) {
          company = org.name;
          return false; // break
        }
      } catch (e) {
        // skip malformed JSON
      }
    });

    // 2. Meta tags
    if (!company) {
      company =
        $('meta[property="og:site_name"]').attr("content") ||
        $('meta[name="twitter:site"]').attr("content") ||
        $('meta[name="author"]').attr("content") ||
        "";
    }

    // 3. Common CSS selectors
    if (!company) {
      const companySelectors = [
        ".company-name",
        ".job-company",
        "[data-company]",
        ".hiring-organization",
        ".top-card-layout__first-subline-link", // LinkedIn
        '[data-testid="company-name"]',
      ];
      for (const selector of companySelectors) {
        if ($(selector).length > 0) {
          company = $(selector).first().text().trim();
          break;
        }
      }
    }

    // 4. Title parsing fallback: "Role at Company" or "Role - Company"
    if (!company && title.includes(" at ")) {
      company = title.split(" at ").pop().trim();
    } else if (!company && title.includes(" - ")) {
      company = title.split(" - ").pop().trim();
    }

    if (!company) {
      company = "Unknown Company";
    }

    // ── Description Extraction ──
    let description = "";

    // Try structured data first
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json["@type"] === "JobPosting" && json.description) {
          // JSON-LD description is often HTML-encoded, strip tags
          description = cheerio.load(json.description).text().trim();
          return false; // break
        }
      } catch (e) {
        // skip
      }
    });

    // Fall back to common containers
    if (!description) {
      const descriptionSelectors = [
        "#job-details",
        ".job-description",
        '[data-testid="job-description"]',
        ".description__text",
        ".job-details",
        ".posting-requirements",
        "article",
        "main",
      ];

      for (const selector of descriptionSelectors) {
        if ($(selector).length > 0) {
          description = $(selector).text().trim();
          break;
        }
      }
    }

    // Last resort: body text (limited)
    if (!description) {
      description = $("body").text().trim().substring(0, 4000);
    }

    // Clean up whitespace
    description = description.replace(/\s+/g, " ").trim();

    return {
      title,
      company,
      description,
      jobUrl: finalUrl,
    };
  } catch (error) {
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

module.exports = { scrapeJob };
