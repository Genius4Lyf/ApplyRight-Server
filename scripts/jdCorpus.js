#!/usr/bin/env node
/**
 * THE JD CORPUS HARNESS — how well do we read a job posting we have never seen?
 *
 * One posting (Renaissance Africa, Operations & Maintenance Technician) proved the pipeline
 * CAN work. It did not prove it does. That single posting exposed four defects — degree
 * fields landing as must-have skills, aliases coming back empty so "PTW" never matched
 * "Permit-to-Work", companyType stuck on "unknown", and raw HTML reaching the JD box — and
 * every one of them was invisible until a real posting went through the real code.
 *
 * This runs the REAL scraper and the REAL extractor over ten postings chosen by failure
 * mode, and grades each one. It is deliberately NOT a Jest test:
 *
 *   • it needs the network and spends money (~10 gpt-4o-mini extractions, a few cents)
 *   • half of what it measures is model output, which drifts
 *
 * The pipeline has two halves that fail differently, so they are graded differently:
 *
 *   URL ──► scrapeJob ──► htmlToMarkdown ──► [ TEXT ] ──► extractJobRequirements ──► brief
 *   PASTE ───────────────────────────────────┘
 *           ╰──────── deterministic ────────╯   ╰──────── a model call ────────╯
 *              repeatable · free · CI-able        costs money · drifts · no assertions
 *
 * Checks 1, 2 and 5 are deterministic. Once --snapshot has saved the HTML, those graduate
 * into ordinary offline Jest tests against the fixtures and run forever for free. Checks
 * 3, 4, 6 and 7 read the model's output: they are a scorecard a human reads, never an
 * assertion. Freezing today's gpt-4o-mini output into expect() is how a suite learns to
 * cry wolf every time OpenAI nudges a model.
 *
 *   node scripts/jdCorpus.js                  run the corpus, write reports
 *   node scripts/jdCorpus.js --snapshot       also save each page to tests/fixtures/jd/
 *   node scripts/jdCorpus.js --only 05,07     re-run two rows after a prompt change
 *   node scripts/jdCorpus.js --scrape-only    stage 1 only — free, no AI calls
 *   node scripts/jdCorpus.js --cache          allow the extraction cache (see below)
 *
 * THE CACHE TRAP, which would otherwise make this whole exercise lie to us.
 *
 * withExtractionCache keys on `operation + sha256(lang + userMsg) + model` — the PROMPT is
 * not in the key. So the moment we tune the extraction prompt and re-run, every posting
 * serves a 30-day-old cached result, nothing moves, and we conclude the change did nothing.
 *
 * So by default this harness never touches Mongo, and sets mongoose's buffer timeout to
 * 1ms so the cache's findOne rejects instantly instead of hanging for the default ten
 * seconds per posting. ai.service already catches that and runs fresh. Expect a
 * "[ExtractionCache] read failed" line per posting — that is the bypass working, not a
 * fault. --cache opts back in when you are re-running an unchanged prompt and only want
 * to re-grade.
 */

// .env first. ai.service decides its provider AT REQUIRE TIME from which key is present,
// so loading this late means every extraction throws AI_UNAVAILABLE. dotenv directly
// rather than src/config/env, which validates the whole server schema (MONGO_URI, JWT
// secrets, Flutterwave keys) and would refuse to start a harness that needs none of it.
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");

// Must happen before any model is required: this is what turns the cache lookup into an
// instant rejection rather than a ten-second stall. See the header.
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const USE_CACHE = flag("cache");
if (!USE_CACHE) mongoose.set("bufferTimeoutMS", 1);

const cheerio = require("cheerio");
const { scrapeJob, carriesRequirements, REQUEST } = require("../src/services/jobScraper.service");
const { extractJobRequirements, roleBriefFromExtraction } = require("../src/services/ai.service");
const {
  mentionsRequirement,
  requirementSurfaces,
} = require("../src/services/skillNormalizer.service");

const ROOT = path.join(__dirname, "jdCorpus");
const CORPUS = path.join(ROOT, "corpus.json");
const OUT = value("out") || path.join(__dirname, "..", "scratchpad", "jdCorpus");
const FIXTURES = path.join(__dirname, "..", "tests", "fixtures", "jd");

// ── The checks ───────────────────────────────────────────────────────────────
//
// Each returns a small object. None of them throw, and none of them decide a run has
// failed: a corpus run reports, a human reads. The only thing that ends a row early is
// the scraper refusing to hand over a description at all.

/** 1 — Which branch won, and is the text it produced actually a job description? */
const checkSource = (scrape, expect) => ({
  source: scrape.source,
  expected: expect?.source || null,
  asExpected: !expect?.source || expect.source === scrape.source,
  quality: scrape.quality,
  chars: scrape.description.length,
  // The SAME question the page fallback asks. Imported, never re-implemented.
  carriesRequirements: carriesRequirements(scrape.description),
});

/** 2 — Markup that should have been converted, not carried. The raw-HTML-in-the-box bug. */
const TAG = /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/gi;
const ENTITY = /&(?:amp|lt|gt|nbsp|quot|#x?[0-9a-f]+);/gi;
const checkMarkup = (text) => {
  const tags = text.match(TAG) || [];
  const entities = text.match(ENTITY) || [];
  return {
    clean: !tags.length && !entities.length,
    tagCount: tags.length,
    entityCount: entities.length,
    sample: [...tags, ...entities].slice(0, 5),
  };
};

/**
 * 3 — Yield. The Renaissance posting listed roughly twelve technical competencies and we
 * came back with seven, so "did it return anything" is not the question; "did it return
 * enough of what was there" is. A long posting that yields under four must-haves is the
 * under-extraction signal.
 */
const THIN_YIELD = 4;
const LONG_POSTING = 1500;
const checkYield = (brief, chars) => {
  const must = brief.mustHaves.length;
  return {
    mustHaves: must,
    niceToHaves: brief.niceToHaves.length,
    responsibilities: (brief.responsibilities || []).length,
    thin: chars >= LONG_POSTING && must < THIN_YIELD,
  };
};

/**
 * 4 — Qualifications. A degree field is a thing you HOLD, not work you did in a role, and
 * one that reaches the interview asks a technician whether they "did Mechanical
 * Engineering" at a job. roleBriefFromExtraction marks them deterministically against
 * requiredEducation; this asks whether that marking actually fired.
 *
 * Two signals, because they fail differently:
 *   flagged  — the marker worked
 *   suspect  — the posting names this must-have right after "degree in" / "HND in" /
 *              "B.Sc in" and it is NOT flagged. That is the marker missing one, usually
 *              because requiredEducation came back null or worded differently.
 */
const DEGREE_CONTEXT =
  /(?:degree|diploma|b\.?sc\.?|bsc|hnd|ond|bachelor'?s?|master'?s?|m\.?sc\.?|ph\.?d\.?)[^.\n]{0,40}?\bin\b([^.\n]{0,140})/gi;
const checkQualifications = (brief, description) => {
  const contexts = [];
  let m;
  DEGREE_CONTEXT.lastIndex = 0;
  while ((m = DEGREE_CONTEXT.exec(description))) contexts.push(m[1].toLowerCase());
  const haystack = contexts.join(" | ");

  // The TYPED requirements, not brief.mustHaves. Both carry the qualification flag, but
  // only the typed array carries sourceText — and a suspect is only actionable if the
  // report can show the JD phrase the model drew it from.
  const typed = (brief.requirements || []).filter(
    (r) => r.priority === "must_have" && r.type !== "responsibility"
  );
  const flagged = typed.filter((r) => r.qualification).map((r) => r.name);
  const suspect = typed
    .filter((r) => !r.qualification)
    .filter((r) => r.name.length > 3 && haystack.includes(r.name.toLowerCase()))
    .map((r) => ({ name: r.name, sourceText: r.sourceText }));

  return {
    requiredEducation: brief.requiredEducation || null,
    flagged,
    suspect,
    clean: suspect.length === 0,
    degreeContexts: contexts.slice(0, 3),
  };
};

/**
 * 5 — The alias round-trip, and the highest-value check here.
 *
 * If the posting STATES a requirement, then the matcher, handed that requirement, must
 * find it in the posting's own text. A miss means a CV that spells it the way the posting
 * does would not count either — which is the PTW / "permit to work" bug, generalised. It
 * is deterministic, so this is the check that most deserves to become a Jest test.
 */
const checkAliasRoundTrip = (brief, description) => {
  const rows = brief.mustHaves.map((r) => ({
    name: r.name,
    aliases: r.aliases || [],
    matches: mentionsRequirement(r, description),
    surfaces: requirementSurfaces(r).size,
  }));
  const missed = rows.filter((r) => !r.matches);
  return {
    total: rows.length,
    matched: rows.length - missed.length,
    missed: missed.map((r) => ({ name: r.name, aliases: r.aliases, surfaces: r.surfaces })),
    noAliases: rows.filter((r) => !r.aliases.length).map((r) => r.name),
  };
};

/** 6 — companyType. Already user-correctable, but "unknown" makes briefBlock say so. */
const checkCompany = (brief) => ({
  companyType: brief.companyType || "unknown",
  unknown: !brief.companyType || brief.companyType === "unknown",
  industry: brief.industry || null,
  seniority: brief.seniority || null,
});

/**
 * 7 — Behavioural leak. Nothing in the code prevents "safety-first mindset" or "team
 * player" becoming a must-have you are then interviewed against. On the Renaissance
 * posting none of its twelve behavioural competencies leaked — but that was luck we
 * checked, not a property we enforce, so it is worth watching across ten.
 */
const SOFT = [
  "team player",
  "teamwork",
  "collaborat",
  "communicat",
  "interpersonal",
  "proactive",
  "self-motivat",
  "detail-orient",
  "attention to detail",
  "problem-solv",
  "work ethic",
  "adaptab",
  "flexib",
  "passionate",
  "enthusias",
  "mindset",
  "can-do",
  "willingness",
  "integrity",
  "respect for",
  "positive attitude",
  "fast-paced",
  "time management",
];
const checkBehavioural = (brief) => {
  const soft = brief.mustHaves.filter((r) => SOFT.some((w) => r.name.toLowerCase().includes(w)));
  // Two different facts, and conflating them would make this cry wolf forever.
  //
  //   leaked — reached the interview. The actual defect.
  //   caught — the model still emitted it and the deterministic marker stopped it. Worth
  //            watching, because it is the running measure of how little the prompt rule
  //            is worth: the alias rule on this same extractor is ignored 92% of the time.
  const leaked = soft.filter((r) => !r.behavioural).map((r) => r.name);
  const caught = soft.filter((r) => r.behavioural).map((r) => r.name);
  return { leaked, caught, clean: leaked.length === 0 };
};

// ── Stage 1: get the text ────────────────────────────────────────────────────

// A snapshot is only worth having if it is BYTE-FOR-BYTE the thing the scraper would have
// received. The first version of this sent only a User-Agent and Workday answered it with a
// 150-byte JSON redirect stub — a fixture that would have "passed" while testing nothing.
// It now borrows the scraper's own REQUEST.
//
// Then it drops what provably cannot reach the result: <script> that is not
// application/ld+json, and <style>. cheerio reads ld+json directly, and htmlToMarkdown
// strips script and style before any text is taken — so this removes weight, not meaning,
// and takes 1.8 MB of minified bundles down to something worth committing. Proven rather
// than assumed: tests/jdFixtures.test.js pins each fixture's scrape result, and the
// trimming was verified to leave every one of them identical.
const LD_JSON = 'script[type="application/ld+json"]';
// A SNAPSHOT IS SOMEONE ELSE'S PAGE, AND IT IS ABOUT TO BE COMMITTED.
//
// The first snapshots here were taken before the trimming existed, and one of them carried
// Greenhouse's own browser-side Google API key — served in an inline `window.ENV` to every
// visitor of every Greenhouse job board. GitHub's secret scanner flagged it on push. It was
// never OUR credential and nothing of ours needed rotating, but it is exactly the kind of
// thing that should never reach a repository by accident, and an alert you have to explain
// away is an alert you learn to ignore.
//
// Stripping non-ld+json scripts removes it today. This is the second line, for the day a
// key turns up in an attribute, a data- blob or the JSON-LD itself, where the trimming
// cannot reach: nothing credential-shaped gets written, whatever it is attached to.
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{35}/g, // Google
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const REDACTED = "REDACTED_BY_JDCORPUS";

const redactSecrets = (html) =>
  SECRET_PATTERNS.reduce((out, re) => out.replace(re, REDACTED), html);

const trimForFixture = (html) => {
  const $ = cheerio.load(html);
  $("script").not(LD_JSON).remove();
  $("style, link[rel='stylesheet'], svg, noscript").remove();
  return redactSecrets($.html());
};

const snapshot = async (id, url) => {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const { data } = await axios.get(url, REQUEST);
  const html = typeof data === "string" ? data : JSON.stringify(data);
  const file = path.join(FIXTURES, `${id}.html`);
  const cleaned = trimForFixture(html);

  // Refuse rather than warn. A snapshot that still matches after redaction means a pattern
  // needs widening, and the one outcome that must not happen is writing it anyway and
  // finding out from an email.
  const missed = SECRET_PATTERNS.filter((re) => {
    re.lastIndex = 0;
    return re.test(cleaned);
  });
  if (missed.length) {
    throw new Error(
      `Refusing to write ${id}.html: ${missed.length} credential-shaped string(s) survived redaction.`
    );
  }

  fs.writeFileSync(file, cleaned, "utf8");
  return file;
};

const readText = async (entry) => {
  if (entry.paste) {
    const file = path.join(ROOT, entry.paste);
    return {
      title: entry.title || "",
      company: entry.company || "",
      description: fs.readFileSync(file, "utf8"),
      source: "typed",
      quality: "full",
      details: {},
    };
  }
  return scrapeJob(entry.url);
};

// ── One posting, end to end ──────────────────────────────────────────────────

const runOne = async (entry, opts) => {
  const started = Date.now();
  const report = { id: entry.id, probes: entry.probes, url: entry.url || entry.paste };

  if (opts.snapshot && entry.url) {
    try {
      report.snapshot = await snapshot(entry.id, entry.url);
    } catch (e) {
      report.snapshotError = e.message;
    }
  }

  let scrape;
  try {
    scrape = await readText(entry);
  } catch (e) {
    // A refusal can be the CORRECT outcome — the bot-wall row expects one. Recording it
    // as a normal result rather than a crash is what lets that row pass.
    report.stage1 = { error: e.message, expected: entry.expect?.error || null };
    report.stage1.asExpected = entry.expect?.error === e.message;
    report.ms = Date.now() - started;
    return report;
  }

  report.title = scrape.title;
  report.company = scrape.company;
  report.stage1 = {
    ...checkSource(scrape, entry.expect),
    markup: checkMarkup(scrape.description),
  };
  report.description = scrape.description;

  if (opts.scrapeOnly) {
    report.ms = Date.now() - started;
    return report;
  }

  let req;
  try {
    req = await extractJobRequirements(scrape.description);
  } catch (e) {
    report.stage2 = { error: e.message };
    report.ms = Date.now() - started;
    return report;
  }

  // The RAW extraction is kept beside the mapped brief, because they answer different
  // questions. roleBriefFromExtraction fills a missing sourceText with the requirement's
  // own name, so a blank brief field cannot tell you whether the model returned nothing
  // or our mapping dropped it. Only the raw object can.
  report.extraction = req;
  const brief = roleBriefFromExtraction(req, scrape.title);
  report.brief = brief;
  report.stage2 = {
    yield: checkYield(brief, scrape.description.length),
    qualifications: checkQualifications(brief, scrape.description),
    aliases: checkAliasRoundTrip(brief, scrape.description),
    company: checkCompany(brief),
    behavioural: checkBehavioural(brief),
  };
  report.ms = Date.now() - started;
  return report;
};

// ── The scorecard ────────────────────────────────────────────────────────────

const mark = (ok) => (ok ? "ok" : "**FAIL**");

const summarise = (reports, opts) => {
  const lines = [];
  lines.push(`# JD corpus — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  lines.push("");
  lines.push(
    `${reports.length} postings · cache ${USE_CACHE ? "ON" : "BYPASSED"}${opts.scrapeOnly ? " · stage 1 only" : ""}`
  );
  lines.push("");

  lines.push("## Stage 1 — reading the page (deterministic)");
  lines.push("");
  lines.push("| # | probes | source | expected | chars | reqs? | markup |");
  lines.push("|---|---|---|---|---|---|---|");
  reports.forEach((r) => {
    const s = r.stage1 || {};
    if (s.error) {
      const ok = s.asExpected;
      lines.push(
        `| ${r.id} | ${r.probes} | \`${s.error}\` | ${s.expected ? `\`${s.expected}\`` : "a description"} | — | — | ${ok ? "ok — refused cleanly" : "**FAIL**"} |`
      );
      return;
    }
    lines.push(
      `| ${r.id} | ${r.probes} | \`${s.source}\` | ${s.expected ? `\`${s.expected}\`` : "—"}${s.asExpected ? "" : " ⚠"} | ${s.chars} | ${mark(s.carriesRequirements)} | ${s.markup.clean ? "clean" : `**${s.markup.tagCount} tags / ${s.markup.entityCount} entities**`} |`
    );
  });
  lines.push("");

  if (!opts.scrapeOnly) {
    lines.push("## Stage 2 — understanding it (model output — read, do not assert)");
    lines.push("");
    lines.push(
      "| # | must | nice | alias round-trip | no aliases | quals flagged | quals missed | companyType | soft leaked | soft caught |"
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    reports.forEach((r) => {
      const s = r.stage2;
      if (!s) return lines.push(`| ${r.id} | — | — | — | — | — | — | — | — | — |`);
      if (s.error) return lines.push(`| ${r.id} | \`${s.error}\` | | | | | | | |`);
      const a = s.aliases;
      lines.push(
        `| ${r.id} | ${s.yield.mustHaves}${s.yield.thin ? " ⚠thin" : ""} | ${s.yield.niceToHaves} | ${a.matched}/${a.total}${a.missed.length ? " **⚠**" : ""} | ${a.noAliases.length} | ${s.qualifications.flagged.length} | ${s.qualifications.suspect.length ? `**${s.qualifications.suspect.length}**` : "0"} | ${s.company.unknown ? "**unknown**" : s.company.companyType} | ${s.behavioural.leaked.length ? `**${s.behavioural.leaked.length}**` : "0"} | ${s.behavioural.caught.length} |`
      );
    });
    lines.push("");

    // The detail behind every ⚠ above, so a bad number is immediately actionable rather
    // than something you then have to go digging for in ten JSON files.
    const notes = [];
    reports.forEach((r) => {
      const s = r.stage2;
      if (!s || s.error) return;
      s.aliases.missed.forEach((m) =>
        notes.push(
          `- **${r.id}** matcher cannot find its own requirement in the posting: \`${m.name}\` (aliases: ${m.aliases.length ? m.aliases.join(", ") : "none"}; ${m.surfaces} surfaces)`
        )
      );
      s.qualifications.suspect.forEach((q) =>
        notes.push(
          `- **${r.id}** degree field left unflagged as a must-have: \`${q.name}\` — drawn from ${JSON.stringify(q.sourceText)}; requiredEducation was ${JSON.stringify(s.qualifications.requiredEducation)}`
        )
      );
      s.behavioural.leaked.forEach((b) =>
        notes.push(`- **${r.id}** behavioural trait REACHED the interview: \`${b}\``)
      );
      if (s.yield.thin)
        notes.push(
          `- **${r.id}** thin yield: ${s.yield.mustHaves} must-haves from ${r.stage1.chars} chars`
        );
    });
    if (notes.length) {
      lines.push("## What to look at");
      lines.push("");
      lines.push(...notes);
      lines.push("");
    }
  }

  lines.push(`Full per-posting reports: \`${path.relative(process.cwd(), OUT)}\``);
  lines.push("");
  return lines.join("\n");
};

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  const opts = { snapshot: flag("snapshot"), scrapeOnly: flag("scrape-only") };
  const only = (value("only") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { postings } = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
  const selected = only.length
    ? postings.filter((p) => only.some((o) => p.id.startsWith(o) || p.id.includes(o)))
    : postings;

  if (!selected.length) {
    console.error(
      `No postings matched --only "${only.join(",")}". Ids: ${postings.map((p) => p.id).join(", ")}`
    );
    process.exit(1);
  }

  if (USE_CACHE) {
    if (!process.env.MONGO_URI) {
      console.error("--cache needs MONGO_URI. Drop the flag to run cache-free.");
      process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
  }

  fs.mkdirSync(OUT, { recursive: true });
  console.log(
    `\nJD corpus — ${selected.length} posting(s), cache ${USE_CACHE ? "ON" : "BYPASSED"}\n`
  );

  const reports = [];
  for (const entry of selected) {
    process.stdout.write(`  ${entry.id} … `);
    let report;
    try {
      report = await runOne(entry, opts);
    } catch (e) {
      // The harness itself broke, which is different from the posting failing.
      report = { id: entry.id, probes: entry.probes, harnessError: e.message };
    }
    reports.push(report);
    fs.writeFileSync(path.join(OUT, `${entry.id}.json`), JSON.stringify(report, null, 2), "utf8");
    const s1 = report.stage1 || {};
    console.log(
      report.harnessError
        ? `harness error: ${report.harnessError}`
        : s1.error
          ? `${s1.error}${s1.asExpected ? " (expected)" : " ⚠"}`
          : `${s1.source} · ${s1.chars} chars${report.stage2 && !report.stage2.error ? ` · ${report.stage2.yield.mustHaves} must-haves` : ""} · ${report.ms}ms`
    );
  }

  const md = summarise(reports, opts);
  const summaryFile = path.join(OUT, "SUMMARY.md");
  fs.writeFileSync(summaryFile, md, "utf8");
  console.log(`\n${md}`);

  if (USE_CACHE) await mongoose.disconnect();
  process.exit(0);
})();
