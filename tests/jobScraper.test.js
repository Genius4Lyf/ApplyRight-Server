// Reading a job posting from its URL.
//
// The claim under test is the ORDER OF PREFERENCE and the HONESTY OF THE RESULT. A good
// posting hands us a Schema.org JobPosting block containing salary, location and dates
// alongside the description; a bad one gives us a two-line marketing summary. Treating
// the second as if it were the first is how an analysis ends up run against a blurb with
// nobody told, so the grade this returns is the thing most worth pinning down.
const axios = require("axios");
const { scrapeJob } = require("../src/services/jobScraper.service");

jest.mock("axios");

const page = (body) => ({ data: `<html><body>${body}</body></html>`, request: {} });

const ldJson = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

// Long enough to clear the full-description floor, so tests about OTHER things aren't
// silently graded as teasers.
const LONG_HTML = `<p>${"We are hiring an offshore rig electrician for a 14/14 rotation. ".repeat(12)}</p>`;

const POSTING = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Rig Electrician",
  hiringOrganization: { "@type": "Organization", name: "Seadrill" },
  description: `<h2>About the role</h2>${LONG_HTML}<h3>Requirements</h3><ul><li>5 years offshore</li><li>CompEx certified</li></ul>`,
  employmentType: "FULL_TIME",
  datePosted: "2026-08-01",
  validThrough: "2026-09-30",
  industry: "Oil & Gas",
  jobLocation: {
    "@type": "Place",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Lagos",
      addressRegion: "Lagos State",
      addressCountry: "NG",
    },
  },
  baseSalary: {
    "@type": "MonetaryAmount",
    currency: "NGN",
    value: { "@type": "QuantitativeValue", minValue: 400000, maxValue: 600000, unitText: "MONTH" },
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("the posting's own structured data", () => {
  it("is preferred over the page, and every field is kept", async () => {
    axios.get.mockResolvedValue(page(ldJson(POSTING)));

    const job = await scrapeJob("https://example.com/jobs/1");

    expect(job.title).toBe("Rig Electrician");
    expect(job.company).toBe("Seadrill");
    expect(job.source).toBe("structured");
    expect(job.quality).toBe("full");
    // The whole point of reading the structured block: these used to be parsed and thrown
    // away, three times over.
    expect(job.details).toMatchObject({
      location: "Lagos, Lagos State, NG",
      employmentType: "FULL_TIME",
      salary: "NGN 400,000–600,000 per MONTH",
      datePosted: "2026-08-01",
      validThrough: "2026-09-30",
      industry: "Oil & Gas",
    });
  });

  it("keeps the description's SHAPE, not just its words", async () => {
    axios.get.mockResolvedValue(page(ldJson(POSTING)));

    const { description } = await scrapeJob("https://example.com/jobs/1");

    // Headings and bullets survive. Previously every one of these collapsed into one
    // unbroken paragraph.
    expect(description).toContain("**About the role**");
    expect(description).toContain("- 5 years offshore");
    expect(description).toContain("- CompEx certified");
    expect(description).not.toContain("<li>");
  });

  it("finds the posting inside an @graph wrapper", async () => {
    axios.get.mockResolvedValue(
      page(
        ldJson({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite" }, POSTING] })
      )
    );

    const job = await scrapeJob("https://example.com/jobs/1");
    expect(job.title).toBe("Rig Electrician");
    expect(job.source).toBe("structured");
  });

  it("survives a malformed JSON-LD block by trying the next one", async () => {
    axios.get.mockResolvedValue(
      page(`<script type="application/ld+json">{ not json </script>${ldJson(POSTING)}`)
    );

    const job = await scrapeJob("https://example.com/jobs/1");
    expect(job.title).toBe("Rig Electrician");
  });

  it("omits details the posting did not state, rather than storing blanks", async () => {
    axios.get.mockResolvedValue(
      page(ldJson({ ...POSTING, baseSalary: undefined, jobLocation: undefined }))
    );

    const { details } = await scrapeJob("https://example.com/jobs/1");
    // "not stated" and "we didn't look" have to stay distinguishable downstream.
    expect(details).not.toHaveProperty("salary");
    expect(details).not.toHaveProperty("location");
    expect(details.employmentType).toBe("FULL_TIME");
  });

  it("decodes entities the posting encoded into its own JSON", async () => {
    // Postings routinely HTML-encode their text before writing it into JSON-LD, and a
    // JSON string never meets an HTML parser — so "&amp;" reached the screen intact and
    // the title rendered as "Full-Time &amp; Internship".
    axios.get.mockResolvedValue(
      page(
        ldJson({
          ...POSTING,
          title: "Full-Time &amp; Internship Program",
          hiringOrganization: { name: "Starsight Energy &amp; Co" },
        })
      )
    );

    const job = await scrapeJob("https://example.com/jobs/1");
    expect(job.title).toBe("Full-Time & Internship Program");
    expect(job.company).toBe("Starsight Energy & Co");
  });

  it("reads a remote posting's location from its type", async () => {
    axios.get.mockResolvedValue(page(ldJson({ ...POSTING, jobLocationType: "TELECOMMUTE" })));

    const { details } = await scrapeJob("https://example.com/jobs/1");
    expect(details.location).toBe("Remote");
  });
});

describe("a page with no structured data", () => {
  it("falls back to a description container and still keeps its shape", async () => {
    axios.get.mockResolvedValue(
      page(
        `<h1>Rig Electrician</h1><div class="job-description">${LONG_HTML}<ul><li>CompEx</li></ul></div>`
      )
    );

    const job = await scrapeJob("https://example.com/jobs/1");

    expect(job.source).toBe("dom");
    expect(job.quality).toBe("full");
    expect(job.description).toContain("- CompEx");
  });
});

describe("a summary is never promoted to a job description", () => {
  it("grades an og:description as a teaser, however long it is", async () => {
    const summary = "Join Seadrill as a Rig Electrician. ".repeat(20); // well past the floor
    axios.get.mockResolvedValue(
      page(`<h1>Rig Electrician</h1><meta property="og:description" content="${summary}">`)
    );

    const job = await scrapeJob("https://example.com/jobs/1");

    // It is returned, not thrown away — the title and company are still worth having, and
    // the caller offers the user a way to fill the gap.
    expect(job.source).toBe("meta");
    expect(job.quality).toBe("teaser");
    expect(job.description.length).toBeGreaterThan(400);
  });

  it("grades a container too short to be a posting as a teaser too", async () => {
    // Between the hard floor (below which there is nothing worth returning at all) and
    // the full-description floor. Real JDs run to thousands of characters; a couple of
    // hundred is a summary box that happened to match one of our selectors.
    const blurb = "Offshore electrical work on a jack-up rig. ".repeat(5);
    axios.get.mockResolvedValue(
      page(`<h1>Rig Electrician</h1><div class="job-description">${blurb}</div>`)
    );

    const job = await scrapeJob("https://example.com/jobs/1");
    expect(job.description.length).toBeGreaterThan(100);
    expect(job.description.length).toBeLessThan(400);
    expect(job.quality).toBe("teaser");
  });
});

describe("pages that give us nothing", () => {
  it("refuses a bot wall rather than passing the challenge text on as a job", async () => {
    axios.get.mockResolvedValue(
      page(
        `<div class="job-description">${"Please verify you are human before continuing. ".repeat(10)}</div>`
      )
    );

    await expect(scrapeJob("https://example.com/jobs/1")).rejects.toThrow("ACCESS_DENIED");
  });

  it("maps a 403 to ACCESS_DENIED and a 404 to JOB_NOT_FOUND", async () => {
    axios.get.mockRejectedValue({ response: { status: 403 } });
    await expect(scrapeJob("https://x.com/1")).rejects.toThrow("ACCESS_DENIED");

    axios.get.mockRejectedValue({ response: { status: 404 } });
    await expect(scrapeJob("https://x.com/1")).rejects.toThrow("JOB_NOT_FOUND");
  });

  it("does not swallow its own ACCESS_DENIED into the generic failure", async () => {
    // The throw happens INSIDE the try block, so a careless catch would relabel it
    // "Failed to scrape job details" and the caller would lose the reason.
    axios.get.mockResolvedValue(page("<p>hi</p>"));
    await expect(scrapeJob("https://x.com/1")).rejects.toThrow("ACCESS_DENIED");
  });
});
