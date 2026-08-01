const DocxService = require("../services/docx.service");
const subscription = require("../services/subscription.service");
const langService = require("../services/language.service");

exports.generateCvDocx = async (req, res) => {
  console.log("--- [DOCX Controller] Generate Request Received ---");
  try {
    const { markdown, userProfile, outputLang } = req.body;

    if (!markdown) {
      console.warn("--- [DOCX Controller] Missing markdown content in request ---");
      return res.status(400).json({ message: "CV markdown content is required" });
    }

    // Download entitlement (WEB only). The native app keeps its own AdMob-rewarded
    // download model, so native requests are exempt (see api.js X-Client-Platform).
    // On web: first download is free (lifetime taste); after that a ₦1,000 single-
    // download pass or any paid subscription (unlimited). Consume BEFORE generating
    // and refund on failure, so a failed doc never burns a unit and concurrent
    // requests can't double-spend.
    const isNativeApp = req.headers["x-client-platform"] === "native";
    let consumed = { ok: true, method: "subscription" }; // native/exempt → nothing consumed
    if (!isNativeApp) {
      consumed = await subscription.consumeDownload(req.user);
      if (!consumed.ok) {
        return res.status(402).json({
          message:
            "Pay ₦1,000 to download this CV as an ATS-ready Word doc, or go unlimited with a plan.",
          code: "NEED_DOWNLOAD",
        });
      }
    }

    // Generate DOCX
    console.log("--- [DOCX Controller] Calling DocxService.generateDocx... ---");
    let buffer;
    try {
      // The CV's DOCUMENT language drives the section labels. The client sends it
      // with the render request (it already holds the draft); an absent/unknown
      // value falls back to the request language, so old clients are unaffected.
      const docLang = langService.isSupported(outputLang) ? outputLang : langService.reqLang(req);
      buffer = await DocxService.generateDocx(markdown, userProfile || {}, docLang);
    } catch (genErr) {
      // Generation failed → give the download unit back.
      await subscription.refundDownload(req.user, consumed.method).catch(() => {});
      throw genErr;
    }
    console.log("--- [DOCX Controller] DOCX Generation Successful. Buffer size:", buffer.length);

    // Send DOCX response
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename="cv-${Date.now()}.docx"`,
    });

    res.send(buffer);
    console.log("--- [DOCX Controller] Response sent ---");

    // Track Export — the file is already on the wire, so NOTHING below may touch
    // the response. A malformed applicationId/draftId throws a CastError here;
    // letting it reach the outer catch would call res.status() on a sent response
    // (ERR_HTTP_HEADERS_SENT) and log a successful download as a failure.
    try {
      const { applicationId, draftId, isDraft, templateId } = req.body;

      // Log the download event
      if (templateId && req.user) {
        const DownloadLog = require("../models/DownloadLog");
        await DownloadLog.create({
          templateId,
          userId: req.user.id,
          applicationId: !isDraft ? applicationId : undefined,
          draftId: isDraft ? applicationId : draftId, // application._id is draftId in draft mode
        });
        console.log(`--- [DOCX Controller] Logged download for template: ${templateId} ---`);
      }

      if (applicationId && !isDraft) {
        const Application = require("../models/Application");
        await Application.findByIdAndUpdate(applicationId, { $inc: { exportCount: 1 } });
      } else if (isDraft || draftId) {
        const DraftCV = require("../models/DraftCV");
        // If isDraft is true, applicationId passed from frontend is actually the draft ID
        const activeDraftId = isDraft ? applicationId : draftId;
        if (activeDraftId) {
          await DraftCV.findByIdAndUpdate(activeDraftId, { $inc: { exportCount: 1 } });
        }
      }
    } catch (trackErr) {
      // Post-send bookkeeping only — the user has their file. Log and move on.
      console.warn("--- [DOCX Controller] Post-download tracking failed:", trackErr.message);
    }
  } catch (error) {
    // Full detail stays server-side; the client never gets a stack trace.
    console.error("--- [DOCX Controller] Error:", error);
    if (res.headersSent) return; // response already streamed — can't re-answer
    res.status(500).json({
      message: "Failed to generate DOCX",
      error:
        process.env.NODE_ENV === "production"
          ? "An unexpected error occurred while generating the document."
          : error.message,
    });
  }
};
