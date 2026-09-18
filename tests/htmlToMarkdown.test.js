// A job description is a STRUCTURED document — "Requirements", then eight bullets, then
// "Benefits". The scraper used to flatten all of it into one paragraph, which is most of
// why a pasted-from-link JD read so badly. These tests pin the structure that survives.
const { htmlToMarkdown } = require("../src/services/htmlToMarkdown.service");

describe("structure survives the conversion", () => {
  it("turns headings into bold lines and bullets into list items", () => {
    const md = htmlToMarkdown(
      "<h2>Requirements</h2><ul><li>5 years offshore</li><li>CompEx certified</li></ul>"
    );

    expect(md).toBe("**Requirements**\n\n- 5 years offshore\n- CompEx certified");
  });

  it("numbers an ordered list", () => {
    expect(htmlToMarkdown("<ol><li>Housing</li><li>Flights</li></ol>")).toBe(
      "1. Housing\n2. Flights"
    );
  });

  it("indents a nested list under the item it belongs to", () => {
    const md = htmlToMarkdown(
      "<ul><li>Skills<ul><li>CompEx</li><li>HV switching</li></ul></li><li>Offshore ticket</li></ul>"
    );

    expect(md).toBe("- Skills\n  - CompEx\n  - HV switching\n- Offshore ticket");
  });

  it("separates a paragraph from the list beside it, on both sides", () => {
    // Closing-only breaks left a paragraph glued to whatever came before it, and a JD
    // alternates paragraphs and lists all the way down.
    expect(htmlToMarkdown("<ol><li>Housing</li></ol><p>Apply here.</p>")).toBe(
      "1. Housing\n\nApply here."
    );
    expect(htmlToMarkdown("<p>You will need:</p><ul><li>A</li></ul>")).toBe(
      "You will need:\n\n- A"
    );
  });

  it("keeps emphasis, and a <br> as a real line break", () => {
    expect(htmlToMarkdown("<p>Salary: <b>NGN 500,000</b><br>Location: Lagos</p>")).toBe(
      "Salary: **NGN 500,000**\nLocation: Lagos"
    );
    expect(htmlToMarkdown("<p>Works <em>14/14</em></p>")).toBe("Works *14/14*");
  });
});

describe("what it throws away", () => {
  it("drops scripts, styles and the page furniture around the posting", () => {
    const md = htmlToMarkdown(
      "<div><script>alert(1)</script><style>p{color:red}</style><p>Real text.</p><button>Apply</button></div>"
    );

    expect(md).toBe("Real text.");
  });

  it("keeps a link's text and loses its href", () => {
    // A posting is full of "Apply here" and cookie-policy links. The one URL worth having
    // is the posting's own, which the scraper returns separately.
    expect(htmlToMarkdown('<p>Apply <a href="https://x.com/apply">here</a>.</p>')).toBe(
      "Apply here."
    );
  });

  it("collapses the blank lines its own walk leaves behind", () => {
    expect(htmlToMarkdown("<div><div><div><p>One.</p></div></div></div>")).toBe("One.");
  });
});

describe("it never throws", () => {
  it("returns plain text unchanged but tidied", () => {
    expect(htmlToMarkdown("Just  plain   text.")).toBe("Just plain text.");
  });

  it("returns an empty string for nothing at all", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
  });

  it("recovers whatever text it can reach in malformed markup", () => {
    // Half a scrape is worth far more than an exception: the posting was already fetched.
    expect(htmlToMarkdown("<div><p>Unclosed paragraph<ul><li>A")).toContain("Unclosed paragraph");
  });
});

// ESCAPED TWICE — the bug a live Flair-hosted posting exposed.
//
// Its JSON-LD `description` was entity-encoded HTML (`&lt;p&gt;`, `&amp;amp;`). There were
// no tags to strip, so the plain-text branch was taken and decoding PRODUCED the markup
// instead of removing it. The posting reached the user as literal `<p>` and
// `<img src="/api/rich-text-image?...">` in the job-description box — and reached the Role
// Brief parser as markup rather than prose.
describe("entity-encoded markup", () => {
  it("converts the HTML a decode reveals, instead of handing it back as text", () => {
    const out = htmlToMarkdown("&lt;p&gt;&lt;strong&gt;Job Purpose&lt;/strong&gt;&lt;/p&gt;");
    expect(out).toBe("**Job Purpose**");
    expect(out).not.toContain("<p>");
  });

  it("drops the markup a real posting carried, image tag and all", () => {
    const out = htmlToMarkdown(
      "&lt;p&gt;&lt;img src=&quot;/api/rich-text-image?objectName=flair__Job__c&amp;amp;fieldName=x&quot; alt=&quot;image.png&quot;&gt;&lt;/img&gt;&lt;/p&gt;&lt;p&gt;Renaissance is a leading integrated energy company.&lt;/p&gt;"
    );
    expect(out).toBe("Renaissance is a leading integrated energy company.");
    expect(out).not.toContain("&amp;");
  });

  it("keeps the structure that makes a posting readable", () => {
    const out = htmlToMarkdown(
      "&lt;p&gt;&lt;strong&gt;Requirements&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Permit-to-Work&lt;/li&gt;&lt;li&gt;HSSE&lt;/li&gt;&lt;/ul&gt;"
    );
    expect(out).toContain("**Requirements**");
    expect(out).toContain("- Permit-to-Work");
    expect(out).toContain("- HSSE");
  });

  it("leaves ordinary text that merely contains an ampersand alone", () => {
    expect(htmlToMarkdown("Operations &amp; Maintenance Technician")).toBe(
      "Operations & Maintenance Technician"
    );
  });

  it("is bounded — it cannot be made to recurse without end", () => {
    // Triple-encoded: decoded twice, then handed back rather than chased forever.
    const tripled = "&amp;amp;lt;p&amp;amp;gt;Deep&amp;amp;lt;/p&amp;amp;gt;";
    expect(() => htmlToMarkdown(tripled)).not.toThrow();
    expect(htmlToMarkdown(tripled)).toContain("Deep");
  });
});
