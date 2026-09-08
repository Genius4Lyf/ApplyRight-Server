const multer = require("multer");
const path = require("path");
const fs = require("fs");

// THE ONE PLACE A CV FILE ENTERS THE SERVER.
//
// Both upload routes used a bare `multer({ dest, limits })` with NO fileFilter, so the
// browser's `accept` attribute was the only thing filtering — and that is a dialog hint,
// not a control. Drag-and-drop ignores it, "All files" defeats it, and a direct POST
// never sees it. Anything up to 5MB reached the parser and came back as a generic error
// after the whole upload had finished.
//
// Two things this fixes. A file we cannot read is refused as it starts arriving instead
// of after it has all been sent — which on a Nigerian mobile connection is the difference
// between an instant answer and a minute of uploading for nothing. And multer's own
// errors stop becoming 500s: the global handler in app.js turns every unhandled error
// into "Internal Server Error", so both an oversized file and a rejected one were
// reported to the user as a server fault.
//
// Deliberately PERMISSIVE: extension OR mimetype is enough. This layer only has the
// file's claims about itself to go on, and being strict here would reject real CVs whose
// browser sent `application/octet-stream` — which Android's picker does routinely. The
// actual decision is made from the file's magic bytes in resumeParser.service, once the
// bytes exist to look at. This is the cheap first pass, not the authority.

const MAX_BYTES = 5 * 1024 * 1024;

const ACCEPTED_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);

const ACCEPTED_MIMETYPES = new Set([
  "application/pdf",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  // Not a typo and not an oversight: some clients send this for a file they cannot
  // classify. It is accepted here and settled by signature in the parser.
  "application/octet-stream",
]);

const UNSUPPORTED_MESSAGE =
  "That file type is not supported. Please upload a PDF, or a Word document (.doc or .docx).";

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ACCEPTED_EXTENSIONS.has(ext) || ACCEPTED_MIMETYPES.has(file.mimetype)) {
    return cb(null, true);
  }
  const error = new Error(UNSUPPORTED_MESSAGE);
  error.code = "UNSUPPORTED_FILE_TYPE";
  return cb(error);
};

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: MAX_BYTES },
  fileFilter,
});

/**
 * `upload.single("resume")`, with multer's failures answered properly.
 *
 * Every response here is a 4xx with a `code`, because none of these is a server fault —
 * they are all "that file will not do", and the user needs to know which.
 */
const resumeUpload = (req, res, next) =>
  upload.single("resume")(req, res, (err) => {
    if (!err) return next();

    // multer aborts mid-write on a size overrun, so a partial temp file can be left
    // behind. Nothing else will ever look at it.
    if (req.file?.path) {
      fs.unlink(req.file.path, () => {});
    }

    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        code: "FILE_TOO_LARGE",
        message: "That file is larger than 5MB. Please upload a smaller PDF or Word document.",
      });
    }

    if (err.code === "UNSUPPORTED_FILE_TYPE") {
      return res.status(400).json({ code: "UNSUPPORTED_FILE_TYPE", message: err.message });
    }

    // Anything else is a genuine multer/stream failure — let the global handler own it.
    return next(err);
  });

module.exports = { resumeUpload, fileFilter, MAX_BYTES, UNSUPPORTED_MESSAGE };
