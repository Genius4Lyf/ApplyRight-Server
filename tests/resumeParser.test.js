const fs = require("fs");
const os = require("os");
const path = require("path");
const { Document, Packer, Paragraph } = require("docx");

const { parseResume, detectFormat } = require("../src/services/resumeParser.service");
const { fileFilter, MAX_BYTES } = require("../src/middleware/resumeUpload.middleware");

// WHAT KIND OF FILE IS THIS, AND CAN WE READ IT?
//
// Two bugs live here, and both were invisible because they failed the same generic way.
//
// 1. `.doc` WAS OFFERED AND NEVER WORKED. The picker has always said
//    `accept=".pdf,.doc,.docx"`, and `application/msword` was routed to mammoth — which
//    reads .docx only and says so in its own first line. Every legacy Word CV came back
//    as "Failed to parse resume", naming nothing. It is not a rare format for this
//    audience: it is what older Word installs and business-centre machines produce.
//
// 2. THE MIMETYPE WAS TRUSTED. Browsers send `application/octet-stream` for Word files
//    often enough — Android's picker does it routinely — so a real CV could be refused
//    for having been described badly by the thing that uploaded it.
//
// The fix for (2) is that the file's own bytes decide. These tests are written against
// signatures rather than filenames for the same reason.

const TEMPLATES = path.join(__dirname, "..", "..", "CV-TEMPLATES");

const tmp = (name, buffer) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ar-parse-")), name);
  fs.writeFileSync(p, buffer);
  return p;
};

// Real signatures, not approximations — this is exactly what a byte-sniffer must see.
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF = Buffer.from("%PDF-1.4\n");
const RTF = Buffer.from("{\\rtf1\\ansi Hello");

// A genuine .docx, built by the `docx` package the app already depends on, so the
// happy path is exercised against a real file rather than a mock of one.
const makeDocx = async (text) =>
  Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] }));

describe("detectFormat — the bytes decide, not the label", () => {
  it("recognises each format from its signature alone", () => {
    expect(detectFormat(PDF, "application/octet-stream", "whatever.bin")).toBe("pdf");
    expect(detectFormat(OLE2, "application/octet-stream", "whatever.bin")).toBe("doc");
    expect(detectFormat(RTF, "application/msword", "cv.doc")).toBe("rtf");
  });

  it("accepts a .docx a browser could not classify", () => {
    // THE REGRESSION THIS GUARDS. Android's picker sends octet-stream for Word files, so
    // trusting the mimetype refused real CVs. The zip signature plus the name is enough.
    expect(detectFormat(ZIP, "application/octet-stream", "My CV.docx")).toBe("docx");
    // ...and the mimetype alone still works, for a browser that got it right.
    expect(
      detectFormat(
        ZIP,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "cv"
      )
    ).toBe("docx");
  });

  it("does not mistake every zip for a Word document", () => {
    // .odt, .pptx, .xlsx and a plain archive all start `PK\x03\x04`, and mammoth reads
    // none of them. The signature has said all it can; without a docx name or mimetype
    // the honest answer is "no".
    expect(detectFormat(ZIP, "application/zip", "photos.zip")).toBeNull();
    expect(detectFormat(ZIP, "application/vnd.oasis.opendocument.text", "cv.odt")).toBeNull();
  });

  it("is not fooled by a name", () => {
    // A .png renamed .pdf is the shape of both an honest mistake and a probe.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectFormat(png, "application/pdf", "cv.pdf")).toBeNull();
  });
});

describe("parseResume — the formats we promise", () => {
  it("reads a real PDF", async () => {
    const sample = path.join(TEMPLATES, "Black White Minimalist CV Resume.pdf");
    if (!fs.existsSync(sample)) return; // the template folder is not part of the package

    const { rawText } = await parseResume(sample, "application/pdf", "cv.pdf");

    expect(rawText.length).toBeGreaterThan(50);
  });

  it("reads a real .docx", async () => {
    const file = tmp("cv.docx", await makeDocx("Ernest Akibor — Offshore Electrician"));

    const { rawText } = await parseResume(file, "application/octet-stream", "cv.docx");

    expect(rawText).toContain("Offshore Electrician");
  });

  it("routes a legacy .doc to the extractor that can actually read it", async () => {
    // The OLE2 header alone is not a readable Word file, so extraction fails — but it
    // must fail HAVING TRIED word-extractor, not by being turned away as an unsupported
    // type. That distinction is the whole bug: `.doc` was offered, then rejected.
    const file = tmp("cv.doc", Buffer.concat([OLE2, Buffer.alloc(512)]));

    await expect(parseResume(file, "application/msword", "cv.doc")).rejects.toMatchObject({
      code: "RESUME_PARSE_FAILED",
    });
  });

  it("proves word-extractor itself works in this Node build", async () => {
    // The `.doc` branch cannot be exercised end-to-end here: a genuine OLE2 Word file
    // needs Word or LibreOffice to produce, and neither is on the build machine. What
    // CAN be pinned is the part most likely to break on a version bump — that the
    // library loads, runs, and that `extract().getBody()` is the API we call. It reads
    // .docx as well as .doc, so its own reader is what is under test here, not mammoth.
    const WordExtractor = require("word-extractor");
    const file = tmp("cv.docx", await makeDocx("Offshore Electrician"));

    const doc = await new WordExtractor().extract(file);

    expect(doc.getBody()).toContain("Offshore Electrician");
  });

  it("tells an RTF-saved-as-.doc apart, and says what to do about it", async () => {
    // Extremely common: "Save as Word 97" in a non-Word editor writes RTF with a .doc
    // name. Word opens it, so the user has no idea. A generic failure leaves them
    // uploading the same file again.
    const file = tmp("cv.doc", RTF);

    await expect(parseResume(file, "application/msword", "cv.doc")).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
    await expect(parseResume(file, "application/msword", "cv.doc")).rejects.toThrow(/\.docx|PDF/i);
  });

  it("refuses a file that is not a document at all", async () => {
    const file = tmp("cv.pdf", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await expect(parseResume(file, "application/pdf", "cv.pdf")).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
  });

  it("separates 'cannot read' from 'nothing in it'", async () => {
    // An empty-but-valid docx is a different problem from an unreadable file, and the
    // user needs a different sentence. Both were RESUME_PARSE_FAILED before.
    const file = tmp("cv.docx", await makeDocx(""));

    await expect(parseResume(file, "application/octet-stream", "cv.docx")).rejects.toMatchObject({
      code: "EMPTY_RESUME_TEXT",
    });
  });
});

describe("the upload filter — refuse it before it is all uploaded", () => {
  const verdict = (originalname, mimetype) => {
    let accepted = null;
    let error = null;
    fileFilter({}, { originalname, mimetype }, (err, ok) => {
      error = err;
      accepted = ok;
    });
    return { accepted, error };
  };

  it("lets the three promised types through", () => {
    expect(verdict("cv.pdf", "application/pdf").accepted).toBe(true);
    expect(verdict("cv.doc", "application/msword").accepted).toBe(true);
    expect(verdict("cv.docx", "application/octet-stream").accepted).toBe(true);
  });

  it("is permissive on purpose, and leaves the real decision to the parser", () => {
    // This layer only has the file's claims to go on. Being strict here would refuse real
    // CVs whose browser mislabelled them; the bytes settle it a moment later, once there
    // are bytes to look at.
    expect(verdict("cv", "application/octet-stream").accepted).toBe(true);
  });

  it("turns away what could never be a CV", () => {
    const { accepted, error } = verdict("holiday.mp4", "video/mp4");

    expect(accepted).toBeUndefined();
    expect(error.code).toBe("UNSUPPORTED_FILE_TYPE");
    // The message has to name the way forward, not just the refusal.
    expect(error.message).toMatch(/PDF/);
  });

  it("keeps the 5MB cap the routes used to declare separately", () => {
    expect(MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});
