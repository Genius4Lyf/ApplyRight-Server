const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  BorderStyle,
} = require("docx");

// docx expresses font size in half-points, so 11pt = 22, 20pt = 40, etc.
const SIZE = {
  name: 40, // ~20pt
  section: 24, // ~12pt
  body: 22, // ~11pt
  small: 20, // ~10pt
};

/**
 * Split a line into runs, turning **bold** spans into bold runs. baseOpts is
 * merged into every run (e.g. { bold: true } for headings). Best-effort — any
 * odd input just renders as plain text.
 */
function parseInlineRuns(text, baseOpts = {}) {
  const str = text == null ? "" : String(text);
  if (!str) return [new TextRun({ text: "", ...baseOpts })];

  const runs = [];
  // Keep the delimiters so we can tell bold spans apart from plain text.
  for (const part of str.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    const m = /^\*\*([^*]+)\*\*$/.exec(part);
    if (m) {
      runs.push(new TextRun({ text: m[1], ...baseOpts, bold: true }));
    } else {
      runs.push(new TextRun({ text: part, ...baseOpts }));
    }
  }
  return runs.length ? runs : [new TextRun({ text: "", ...baseOpts })];
}

/**
 * Build a clean, single-column, ATS-friendly Word document (Buffer) from CV
 * markdown + the user's profile. No tables / text boxes / columns so ATS
 * parsers read it top-to-bottom. Robust: never throws on odd markdown.
 *
 * @param {string} markdown  The CV markdown body.
 * @param {object} userProfile  { firstName, otherName, lastName, email, phone, location, linkedinUrl }
 * @returns {Promise<Buffer>}
 */
const generateDocx = async (markdown = "", userProfile = {}) => {
  const children = [];

  try {
    const md = typeof markdown === "string" ? markdown : "";
    const lines = md.split(/\r?\n/);
    const profile = userProfile || {};

    // --- Name: first `# H1`, else the profile name, else a safe fallback. ---
    let name = "";
    const h1Line = lines.find((l) => /^#\s+\S/.test(l.trim()));
    if (h1Line) name = h1Line.trim().replace(/^#\s+/, "").trim();
    if (!name) {
      name = [profile.firstName, profile.otherName, profile.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
    }
    if (!name) name = "Your Name";

    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [new TextRun({ text: name, bold: true, size: SIZE.name })],
      })
    );

    // --- Contact line from the profile (only the parts we have). ---
    const contactBits = [];
    if (profile.email) contactBits.push(String(profile.email));
    if (profile.phone) contactBits.push(String(profile.phone));
    if (profile.location) contactBits.push(String(profile.location));
    const linkedin = profile.linkedinUrl || profile.linkedin;
    if (linkedin) contactBits.push(String(linkedin).replace(/^https?:\/\/(www\.)?/, ""));
    if (contactBits.length) {
      children.push(
        new Paragraph({
          spacing: { after: 200 },
          children: [
            new TextRun({ text: contactBits.join("   ·   "), size: SIZE.small, color: "444444" }),
          ],
        })
      );
    }

    // --- Body. Skip the first H1 (used as the name above). ---
    let firstH1Skipped = false;
    for (const raw of lines) {
      const t = String(raw).trim();
      if (t === "") continue; // paragraph spacing already handles gaps

      // Horizontal rules → ignore (they map to our section borders instead).
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue;

      // H1 (name). Skip the first; ignore any stray extras.
      if (/^#\s+\S/.test(t)) {
        firstH1Skipped = true;
        continue;
      }

      // #### company · dates (normal, slightly muted).
      if (/^####\s+/.test(t)) {
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: parseInlineRuns(t.replace(/^####\s+/, "").trim(), {
              size: SIZE.body,
              color: "444444",
            }),
          })
        );
        continue;
      }

      // ### role / title (bold).
      if (/^###\s+/.test(t)) {
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 20 },
            children: parseInlineRuns(t.replace(/^###\s+/, "").trim(), {
              size: SIZE.body,
              bold: true,
            }),
          })
        );
        continue;
      }

      // ## SECTION (uppercase, bold, rule underneath).
      if (/^##\s+/.test(t)) {
        children.push(
          new Paragraph({
            spacing: { before: 240, after: 80 },
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 6, space: 2, color: "999999" },
            },
            children: [
              new TextRun({
                text: t.replace(/^##\s+/, "").trim().toUpperCase(),
                bold: true,
                size: SIZE.section,
              }),
            ],
          })
        );
        continue;
      }

      // - / * bullet → real Word bullet (ATS-safe list, not a table).
      if (/^[-*]\s+/.test(t)) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 20 },
            children: parseInlineRuns(t.replace(/^[-*]\s+/, "").trim(), { size: SIZE.body }),
          })
        );
        continue;
      }

      // Plain paragraph.
      children.push(
        new Paragraph({
          spacing: { after: 80 },
          alignment: AlignmentType.LEFT,
          children: parseInlineRuns(t, { size: SIZE.body }),
        })
      );
    }

    // Silence the unused-var linter without changing behaviour.
    void firstH1Skipped;
  } catch (err) {
    // Best-effort: never throw. Emit whatever we built (plus a marker if empty).
    console.error("[docx.service] Failed to parse CV markdown:", err);
    if (children.length === 0) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: "CV", bold: true, size: SIZE.name })] })
      );
    }
  }

  const doc = new Document({
    // One standard, ATS-safe font throughout; sizes overridden per element.
    styles: {
      default: {
        document: { run: { font: "Calibri", size: SIZE.body } },
      },
    },
    sections: [
      {
        properties: {},
        children: children.length
          ? children
          : [new Paragraph({ children: [new TextRun({ text: "" })] })],
      },
    ],
  });

  return Packer.toBuffer(doc);
};

module.exports = { generateDocx };
