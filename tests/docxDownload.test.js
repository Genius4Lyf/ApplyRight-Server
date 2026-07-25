// Regression tests for the DOCX download error path.
//
// Two production failure modes are covered:
//   1. Post-send tracking (DownloadLog / exportCount) threw — e.g. a CastError from
//      a malformed draftId — and the outer catch answered an ALREADY-SENT response,
//      producing ERR_HTTP_HEADERS_SENT and logging a good download as a failure.
//   2. The 500 body leaked `error.stack` to the client.
jest.mock("../src/services/docx.service");
jest.mock("../src/services/subscription.service");
jest.mock("../src/models/DownloadLog");
jest.mock("../src/models/DraftCV");
jest.mock("../src/models/Application");

const DocxService = require("../src/services/docx.service");
const subscription = require("../src/services/subscription.service");
const DownloadLog = require("../src/models/DownloadLog");
const DraftCV = require("../src/models/DraftCV");
const { generateCvDocx } = require("../src/controllers/docx.controller");

// Minimal Express-shaped response double that tracks headersSent the way Node does.
const makeRes = () => {
  const res = {
    headersSent: false,
    statusCode: 200,
    headers: {},
    body: undefined,
    set(h) {
      Object.assign(this.headers, h);
      return this;
    },
    status(code) {
      if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
      this.statusCode = code;
      return this;
    },
    json(payload) {
      if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
      this.headersSent = true;
      this.body = payload;
      return this;
    },
    send(payload) {
      if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT");
      this.headersSent = true;
      this.body = payload;
      return this;
    },
  };
  return res;
};

const makeReq = (body = {}) => ({
  body: { markdown: "# Jane Doe\n\n## Experience\n- Shipped things", ...body },
  headers: {},
  user: { id: "u1" },
});

describe("docx.controller — download error handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    subscription.consumeDownload.mockResolvedValue({ ok: true, method: "subscription" });
    subscription.refundDownload.mockResolvedValue();
    DocxService.generateDocx.mockResolvedValue(Buffer.from("PK-fake-docx"));
    DownloadLog.create.mockResolvedValue({});
    DraftCV.findByIdAndUpdate.mockResolvedValue({});
  });

  it("still returns the file when post-send tracking throws on a bad draftId", async () => {
    const castError = new Error('Cast to ObjectId failed for value "not-an-id"');
    castError.name = "CastError";
    DraftCV.findByIdAndUpdate.mockRejectedValue(castError);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = makeRes();
    // Must not reject: the old code hit the outer catch → res.status() after send.
    await expect(
      generateCvDocx(makeReq({ isDraft: true, applicationId: "not-an-id" }), res)
    ).resolves.toBeUndefined();

    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.headers["Content-Type"]).toMatch(/wordprocessingml\.document/);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Post-download tracking failed"),
      expect.stringContaining("Cast to ObjectId failed")
    );
    warn.mockRestore();
  });

  it("survives a DownloadLog failure without touching the response", async () => {
    DownloadLog.create.mockRejectedValue(new Error("mongo down"));
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = makeRes();
    await generateCvDocx(makeReq({ templateId: "modern" }), res);

    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    console.warn.mockRestore();
  });

  it("500s properly when generation fails, and refunds the download", async () => {
    DocxService.generateDocx.mockRejectedValue(new Error("Unexpected token in markdown"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const res = makeRes();
    await generateCvDocx(makeReq({ markdown: "###|||broken" }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe("Failed to generate DOCX");
    expect(res.body.error).toBe("Unexpected token in markdown");
    expect(subscription.refundDownload).toHaveBeenCalledWith(expect.anything(), "subscription");
    console.error.mockRestore();
  });

  it("never returns a stack trace to the client", async () => {
    DocxService.generateDocx.mockRejectedValue(new Error("boom"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const res = makeRes();
    await generateCvDocx(makeReq(), res);

    expect(res.body).not.toHaveProperty("stack");
    expect(JSON.stringify(res.body)).not.toMatch(/docx\.controller\.js:/);
    console.error.mockRestore();
  });

  it("keeps the 500 message generic in production", async () => {
    DocxService.generateDocx.mockRejectedValue(new Error("MONGO_URI=secret leaked here"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const res = makeRes();
    await generateCvDocx(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("An unexpected error occurred while generating the document.");
    expect(JSON.stringify(res.body)).not.toMatch(/secret leaked/);

    process.env.NODE_ENV = prevEnv;
    console.error.mockRestore();
  });

  it("returns the NEED_DOWNLOAD 402 as JSON (unchanged paywall contract)", async () => {
    subscription.consumeDownload.mockResolvedValue({ ok: false });

    const res = makeRes();
    await generateCvDocx(makeReq(), res);

    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe("NEED_DOWNLOAD");
    expect(DocxService.generateDocx).not.toHaveBeenCalled();
  });
});
