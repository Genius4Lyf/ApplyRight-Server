const cheerio = require("cheerio");

// Turn a job posting's HTML into readable Markdown.
//
// WHY THIS EXISTS: the scraper used to run `.text()` over the description and then
// `replace(/\s+/g, " ")`, which collapsed every bullet, heading and paragraph break into
// one unbroken wall of text. A job description is a STRUCTURED document — "Requirements",
// then eight bullets, then "Benefits" — and that structure is most of what makes it
// readable. Flattening it also costs the AI: a bulleted requirement list is far easier to
// extract must-haves from than the same words run together.
//
// WHY NOT A LIBRARY: turndown is the obvious answer, but a job posting uses about six
// tags, and this is a deploy that has been bitten by dependencies before. Forty lines we
// control beats a general-purpose converter whose output we would have to constrain
// anyway.
//
// HEADINGS BECOME BOLD, NOT `##`. The result is fed into AI prompts that talk about CV
// sections in `## Experience` terms — a scraped "## Requirements" landing in that context
// invites the model to read the JD as part of the document being written. Bold reads the
// same to a person and carries no structural claim.

// Tags whose content is never part of the posting.
const DROP = new Set(["script", "style", "noscript", "svg", "iframe", "form", "button"]);

// Tags that force a break between blocks.
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "table",
  "tr",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const HEADING = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

// Inline whitespace only — newlines are structure here and are added deliberately, so
// they must survive this.
const squashInline = (s) => s.replace(/[ \t ]+/g, " ");

/**
 * Decode HTML entities in a string that carries no markup.
 *
 * Postings routinely HTML-encode their own text before putting it in JSON-LD, so a title
 * arrives as "Full-Time &amp; Internship" and, having no tags, never goes near a parser.
 * Left alone it renders as the literal "&amp;" on screen — which is exactly what it did.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  const str = String(value || "");
  // Cheap guard: no ampersand, nothing to decode, and no parse to pay for.
  if (!str.includes("&")) return str;
  try {
    return cheerio.load(`<x>${str}</x>`)("x").text();
  } catch {
    return str;
  }
}

/**
 * Convert a fragment of job-posting HTML to Markdown.
 *
 * Tolerant by design: given plain text it returns it (tidied), and given malformed HTML
 * it returns whatever text it could reach. A scrape that produces slightly untidy
 * Markdown is worth far more than one that throws.
 *
 * @param {string} html
 * @returns {string} Markdown, or '' when there was nothing to convert
 */
function htmlToMarkdown(html) {
  const input = String(html || "").trim();
  if (!input) return "";

  // No tags at all — it is already plain text. Normalise its spacing and decode any
  // entities (there is no parser on this path to do it for us), rather than
  // round-tripping through one that would strip nothing.
  if (!/<[a-z!/]/i.test(input)) return tidy(decodeEntities(input));

  let $;
  try {
    $ = cheerio.load(input);
  } catch {
    return tidy(input);
  }

  const out = [];

  const walk = (node, depth = 0, listType = null, indexRef = null) => {
    if (!node) return;

    if (node.type === "text") {
      out.push(squashInline(node.data || ""));
      return;
    }
    if (node.type !== "tag") return;

    const tag = (node.name || "").toLowerCase();
    if (DROP.has(tag)) return;

    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (tag === "hr") {
      out.push("\n\n---\n\n");
      return;
    }

    const children = node.children || [];

    if (tag === "ul" || tag === "ol") {
      // No break of its own: every `li` below opens with one, and a list nested inside an
      // `li` would otherwise be pushed a blank line away from the item it belongs to.
      const counter = { n: 0 };
      for (const child of children) walk(child, depth + 1, tag, counter);
      return;
    }

    if (tag === "li") {
      // Nested lists indent by two spaces per level; the top level sits flush so a JD's
      // requirement list reads as one column rather than a staircase.
      const indent = "  ".repeat(Math.max(0, depth - 1));
      if (listType === "ol" && indexRef) {
        indexRef.n += 1;
        out.push(`\n${indent}${indexRef.n}. `);
      } else {
        out.push(`\n${indent}- `);
      }
      for (const child of children) walk(child, depth, null, null);
      return;
    }

    if (HEADING.has(tag)) {
      out.push("\n\n**");
      for (const child of children) walk(child, depth, listType, indexRef);
      out.push("**\n\n");
      return;
    }

    if (tag === "strong" || tag === "b") {
      // A heading is already bold; nesting more asterisks inside one produces `****`.
      out.push("**");
      for (const child of children) walk(child, depth, listType, indexRef);
      out.push("**");
      return;
    }

    if (tag === "em" || tag === "i") {
      out.push("*");
      for (const child of children) walk(child, depth, listType, indexRef);
      out.push("*");
      return;
    }

    // Links keep their TEXT and lose their href. A posting is full of "Apply here" and
    // cookie-policy links; the one URL worth keeping is the posting's own, and the
    // scraper already returns that separately.
    //
    // A block breaks on BOTH sides. Closing only would leave a paragraph glued to
    // whatever came before it — a list, most often, since a JD alternates the two.
    // `tidy` collapses the runs this creates.
    if (BLOCK.has(tag)) out.push("\n\n");
    for (const child of children) walk(child, depth, listType, indexRef);
    if (BLOCK.has(tag)) out.push("\n\n");
  };

  const roots = $.root().children().toArray();
  for (const root of roots) walk(root);

  return tidy(out.join(""));
}

// Collapse the debris the walk leaves behind: runs of blank lines, trailing spaces, and
// bullets that ended up empty because their content was a dropped tag.
function tidy(text) {
  return (
    String(text)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      // LEADING whitespace is spared: it is a nested list's indent, and squashing it would
      // flatten every sub-bullet back into the parent list.
      .map((line) => {
        const indent = line.match(/^[ \t]*/)[0];
        return indent + squashInline(line.slice(indent.length)).trimEnd();
      })
      .join("\n")
      .replace(/\*\*\s*\*\*/g, "")
      .replace(/^[ \t]*[-*][ \t]*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

module.exports = { htmlToMarkdown, decodeEntities };
