const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");
const fs = require("fs");
const path = require("path");

const buildParserError = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

// WHAT KIND OF FILE IS THIS, ACTUALLY?
//
// Not "what did the browser call it". The uploader offers .pdf/.doc/.docx, but the
// mimetype that arrives with them is not dependable: browsers send `application/
// octet-stream` for Word files often enough, Android's picker sends it routinely, and
// anyone can rename a file. Deciding on the claim rather than the content is how a
// perfectly good CV gets told it is the wrong type.
//
// So the first four to eight bytes decide, because those are the one thing the file
// cannot be wrong about. The declared type is only consulted where the signature is
// genuinely ambiguous — see the ZIP case below.
const SIG = {
  pdf: [0x25, 0x50, 0x44, 0x46], // "%PDF"
  zip: [0x50, 0x4b, 0x03, 0x04], // "PK\x03\x04" — .docx is a zip, but so is much else
  ole2: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // Word 97–2003 .doc
  rtf: [0x7b, 0x5c, 0x72, 0x74, 0x66], // "{\rtf"
};

const startsWith = (buffer, bytes) =>
  buffer.length >= bytes.length && bytes.every((b, i) => buffer[i] === b);

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const detectFormat = (head, mimetype, originalName) => {
  if (startsWith(head, SIG.pdf)) return "pdf";
  if (startsWith(head, SIG.ole2)) return "doc";
  if (startsWith(head, SIG.rtf)) return "rtf";

  if (startsWith(head, SIG.zip)) {
    // A .docx IS a zip — but so are .odt, .pptx, .xlsx and a plain archive, and mammoth
    // reads none of those. The signature has told us all it can, so here (and only here)
    // the declared type breaks the tie.
    const ext = path.extname(originalName || "").toLowerCase();
    if (ext === ".docx" || mimetype === DOCX_MIME) return "docx";
    return null;
  }

  return null;
};

// One sentence per format we cannot read, naming the way out. "Unsupported file type" on
// its own leaves someone re-uploading the same file, because it does not say what to do.
const REJECTION = {
  rtf: "This looks like an RTF file saved with a .doc name. Open it in Word and use “Save As” → Word Document (.docx), or export it as a PDF.",
  default:
    "That file is not a CV we can read. Please upload a PDF, or a Word document (.doc or .docx).",
};

const extractText = async (format, filePath) => {
  if (format === "pdf") {
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text;
  }

  if (format === "docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (format === "doc") {
    // THE FORMAT THAT WAS OFFERED BUT NEVER WORKED.
    //
    // The uploader has always accepted ".doc", and `application/msword` was routed to
    // mammoth — which reads .docx only, and says so in its own first line. So every
    // legacy Word CV failed with a generic "Failed to parse resume", telling the user
    // nothing about why. It is not a rare format for this audience: it is what older
    // Word installs and business-centre machines still produce.
    //
    // word-extractor reads the OLE2 binary format in pure JS — no system binary, nothing
    // for Render to install, which rules out antiword and textract.
    const doc = await new WordExtractor().extract(filePath);
    // getBody() is the document text; headers and footers are deliberately left out —
    // page furniture is not CV content and only dilutes the extraction.
    return doc.getBody();
  }

  throw buildParserError(REJECTION.default, "UNSUPPORTED_FILE_TYPE");
};

/**
 * Pull the raw text out of an uploaded CV.
 *
 * @param {string} filePath
 * @param {string} mimetype      as declared by the browser — a hint, never the decision
 * @param {string} [originalName] used only to disambiguate .docx from other zip formats
 */
const parseResume = async (filePath, mimetype, originalName) => {
  let format = null;

  try {
    // Enough for the longest signature we check. Read once, up front, so a file we cannot
    // read costs one 8-byte read rather than a whole parse attempt.
    const handle = fs.openSync(filePath, "r");
    const head = Buffer.alloc(8);
    try {
      fs.readSync(handle, head, 0, 8, 0);
    } finally {
      fs.closeSync(handle);
    }

    format = detectFormat(head, mimetype, originalName);

    if (!format || format === "rtf") {
      throw buildParserError(REJECTION[format] || REJECTION.default, "UNSUPPORTED_FILE_TYPE");
    }

    let rawText = await extractText(format, filePath);

    // Basic cleaning — remove excessive newlines
    rawText = String(rawText || "")
      .replace(/\n\s*\n/g, "\n")
      .trim();

    if (!rawText) {
      throw buildParserError("No extractable text found in resume", "EMPTY_RESUME_TEXT");
    }

    return { rawText };
  } catch (error) {
    console.error("Parsing Error:", error.message);

    if (error.code === "UNSUPPORTED_FILE_TYPE" || error.code === "EMPTY_RESUME_TEXT") {
      throw error;
    }

    // A file whose signature we recognised but whose parser then gave up: a Word-shaped
    // OLE2 file that is really an .xls, a corrupt download, a password-protected PDF.
    // Naming the format we TRIED is what makes this reportable — "failed to parse" alone
    // has left us unable to tell a broken file from a broken parser.
    throw buildParserError(
      "We could not read that file. It may be damaged, password-protected, or not really a CV.",
      "RESUME_PARSE_FAILED"
    );
  }
};

module.exports = { parseResume, detectFormat, SIG };
