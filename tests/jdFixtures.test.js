// READING A REAL JOB POSTING — offline, free, forever.
//
// Every JD-reading defect this project has fixed was found by putting a REAL posting
// through the real code: raw HTML in the description box, a posting that was only its
// introduction, a requirement invisible because a line break fell between its words. None
// of them were reachable from a hand-written fixture, because none of us would have
// written a page that broken on purpose.
//
// scripts/jdCorpus.js runs ten such postings against the live web and a live model. That
// is a lab run: it needs the network, it spends money, and half of what it measures is
// model output that drifts. This file is the half that does NOT drift — the same postings,
// snapshotted to tests/fixtures/jd/, asserted on every `npm test`.
//
// The snapshots are the pages as the SCRAPER receives them: taken with jobScraper's own
// exported REQUEST, because asking with only a User-Agent got Workday to answer with a
// 150-byte JSON redirect stub — a fixture that would have passed while testing nothing.
// Non-ld+json <script> and <style> are stripped to keep them committable (1.8 MB → 444 KB);
// that provably cannot change the result, since cheerio reads ld+json directly and
// htmlToMarkdown removes script and style before it takes any text. Every expectation
// below was verified against the LIVE fetch before being written down.
//
// To refresh: node scripts/jdCorpus.js --scrape-only --snapshot

const fs = require("fs");
const path = require("path");
const axios = require("axios");

jest.mock("axios");

const { scrapeJob, carriesRequirements } = require("../src/services/jobScraper.service");
const { mentionsRequirement } = require("../src/services/skillNormalizer.service");

const FIXTURES = path.join(__dirname, "fixtures", "jd");
const PASTES = path.join(__dirname, "..", "scripts", "jdCorpus", "pastes");

// Markup that should have been CONVERTED, not carried. The bug a user screenshotted:
// literal <p> and <img src="/api/rich-text-image?…"> in the job-description box, because a
// double-escaped JSON-LD description decoded INTO markup on the plain-text path.
const TAG = /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i;
const ENTITY = /&(?:amp|lt|gt|nbsp|quot|#x?[0-9a-f]+);/i;

// `mentions` are phrases the posting genuinely states; `absent` are ones it does not, and
// they are what stops a matcher change from passing by simply saying yes to everything.
const PAGES = [
  {
    id: "01-greenhouse",
    // No JSON-LD anywhere on the page and not one of our ten DOM selectors matches, so the
    // world's most common ATS survives on the last-resort whole-page branch.
    source: "page",
    minChars: 7000,
    maxChars: 8200,
    mentions: ["partner management", "e-commerce", "performance marketing"],
    absent: ["Kubernetes"],
  },
  {
    id: "02-lever",
    source: "structured",
    minChars: 4000,
    maxChars: 5200,
    mentions: ["administrative support", "critical thinking"],
    absent: ["Kubernetes"],
  },
  {
    id: "03-ashby",
    // Two JobPosting blocks on one page, so findJobPosting has to choose.
    source: "structured",
    minChars: 5000,
    maxChars: 6400,
    mentions: ["Sales Development", "prospecting", "Salesforce"],
    absent: ["Kubernetes"],
  },
  {
    id: "04-workday",
    source: "structured",
    minChars: 3000,
    maxChars: 3600,
    // Workday's JSON-LD description is PLAIN TEXT: 3,233 characters with zero newlines and
    // zero bullets, so there is no structure to convert and carriesRequirements is false on
    // a posting that plainly states its requirements. Pinned deliberately — see §6bg.
    carriesRequirements: false,
    mentions: ["formal verification", "computer architecture", "Haskell", "TLA+"],
    // The posting names half a dozen languages; Java is not among them.
    absent: ["Java"],
  },
  {
    id: "05-flair",
    // A SECOND Flair tenant. Its JSON-LD is entity-encoded the same way the posting that
    // produced the raw-HTML bug was, so the markup assertion below is the real test here.
    source: "structured",
    minChars: 900,
    maxChars: 1300,
    mentions: ["Forklift Operator", "safety"],
    absent: ["Kubernetes"],
  },
  {
    id: "06-jobberman",
    // Three JobPosting blocks. Short by nature — 618 characters is the whole posting, not
    // a truncation.
    source: "structured",
    minChars: 500,
    maxChars: 800,
    mentions: ["livestock management", "animal science", "observation"],
    absent: ["Kubernetes"],
  },
  {
    id: "07-myjobmag",
    // Its single ld+json block does not parse at all, so this one has to survive on the
    // DOM path or not at all.
    source: "dom",
    minChars: 3000,
    maxChars: 4100,
    mentions: ["Operations Officer", "healthcare"],
    absent: ["Kubernetes"],
  },
];

const load = (id) => fs.readFileSync(path.join(FIXTURES, `${id}.html`), "utf8");

beforeEach(() => {
  jest.clearAllMocks();
});

describe.each(PAGES)("$id", (fx) => {
  const scrape = async () => {
    axios.get.mockResolvedValue({ data: load(fx.id), request: {} });
    return scrapeJob(`https://fixture.test/${fx.id}`);
  };

  it("reads the posting from the branch it is supposed to", async () => {
    expect((await scrape()).source).toBe(fx.source);
  });

  it("returns the posting, not a blurb", async () => {
    const { description, quality } = await scrape();
    expect(description.length).toBeGreaterThanOrEqual(fx.minChars);
    // A CEILING as well as a floor. The page branch reads a whole document and keeps
    // whatever survives PAGE_FURNITURE, so the way it fails is by GROWING — swallowing
    // nav, related jobs or the application form. A floor alone would never notice.
    expect(description.length).toBeLessThanOrEqual(fx.maxChars);
    expect(quality).toBe("full");
  });

  it("carries the things the employer asked for", async () => {
    const { description } = await scrape();
    expect(carriesRequirements(description)).toBe(fx.carriesRequirements !== false);
  });

  it("converts the markup instead of carrying it", async () => {
    const { description } = await scrape();
    expect(TAG.test(description)).toBe(false);
    expect(ENTITY.test(description)).toBe(false);
  });

  it("states its requirements in text the matcher can find", async () => {
    const { description } = await scrape();
    fx.mentions.forEach((name) => {
      expect({ name, found: mentionsRequirement({ name }, description) }).toEqual({
        name,
        found: true,
      });
    });
  });

  it("does not match a requirement the posting never names", async () => {
    const { description } = await scrape();
    fx.absent.forEach((name) => {
      expect({ name, found: mentionsRequirement({ name }, description) }).toEqual({
        name,
        found: false,
      });
    });
  });
});

// The bot wall. A CLEAN refusal is the pass — the failure mode worth preventing is a
// captcha page being accepted as a job description and silently analysed.
describe("08-indeed-wall", () => {
  it("refuses a 403 rather than returning the wall as a posting", async () => {
    axios.get.mockRejectedValue({ response: { status: 403 } });
    await expect(scrapeJob("https://fixture.test/indeed")).rejects.toThrow("ACCESS_DENIED");
  });
});

// PASTED text never touches the scraper, which makes it the only way to test the reader
// without scrape quality as a confound — and it is where the hard wraps live.
describe("pasted postings", () => {
  const paste = (file) => fs.readFileSync(path.join(PASTES, file), "utf8");

  // The row that exposed the line-break bug: seven of eleven must-haves were reported
  // missing from a posting naming every one of them, because Word wraps at a space and
  // "microsoft excel" is not a substring of "microsoft\r\nexcel".
  it("finds requirements broken across a hard wrap in a Word paste", () => {
    const text = paste("09-paste-word.txt");
    ["Microsoft Excel", "Accounts Payable", "Audit Support"].forEach((name) => {
      expect({ name, found: mentionsRequirement({ name }, text) }).toEqual({ name, found: true });
    });
  });

  it("still refuses what a Word paste does not say", () => {
    expect(mentionsRequirement({ name: "Kubernetes" }, paste("09-paste-word.txt"))).toBe(false);
  });

  it("reads a LinkedIn paste whose bullets were flattened into prose", () => {
    const text = paste("10-paste-linkedin.txt");
    ["market research", "business development"].forEach((name) => {
      expect({ name, found: mentionsRequirement({ name }, text) }).toEqual({ name, found: true });
    });
  });
});
