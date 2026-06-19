const PdfService = require("../services/pdf.service");
const subscription = require("../services/subscription.service");

exports.generateCvPdf = async (req, res) => {
  console.log("--- [PDF Controller] Generate Request Received ---");
  try {
    const { html, options } = req.body;

    if (!html) {
      console.warn("--- [PDF Controller] Missing HTML content in request ---");
      return res.status(400).json({ message: "HTML content is required" });
    }

    // Download entitlement (WEB only). The native app keeps its own AdMob-rewarded
    // download model, so native requests are exempt (see api.js X-Client-Platform).
    // On web: first download is free (lifetime taste); after that a ₦500 single-
    // download pass or any paid subscription (unlimited). Consume BEFORE generating
    // and refund on failure, so a failed PDF never burns a unit and concurrent
    // requests can't double-spend.
    const isNativeApp = req.headers["x-client-platform"] === "native";
    let consumed = { ok: true, method: "subscription" }; // native/exempt → nothing consumed
    if (!isNativeApp) {
      consumed = await subscription.consumeDownload(req.user);
      if (!consumed.ok) {
        return res.status(402).json({
          message:
            "You've used your free download. Pay ₦500 to download this CV, or go unlimited with a plan.",
          code: "NEED_DOWNLOAD",
        });
      }
    }

    console.log(`--- [PDF Controller] HTML Content Length: ${html.length} chars ---`);
    console.log("--- [PDF Controller] Options:", JSON.stringify(options || {}));

    // Generate PDF with options
    console.log("--- [PDF Controller] Calling PdfService.generatePdf... ---");
    let buffer;
    try {
      buffer = await PdfService.generatePdf(html, options || {});
    } catch (genErr) {
      // Generation failed → give the download unit back.
      await subscription.refundDownload(req.user, consumed.method).catch(() => {});
      throw genErr;
    }
    console.log("--- [PDF Controller] PDF Generation Successful. Buffer size:", buffer.length);

    // Send PDF response
    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename="cv-${Date.now()}.pdf"`,
    });

    res.send(buffer);
    // res.send(buffer); // Already sent above
    console.log("--- [PDF Controller] Response sent ---");

    // Track Export
    // Track Export
    const { applicationId, draftId, isDraft, templateId } = req.body;
    const DownloadLog = require("../models/DownloadLog");

    // Log the download event
    if (templateId && req.user) {
      try {
        await DownloadLog.create({
          templateId,
          userId: req.user.id,
          applicationId: !isDraft ? applicationId : undefined,
          draftId: isDraft ? applicationId : draftId, // application._id is draftId in draft mode
        });
        console.log(`--- [PDF Controller] Logged download for template: ${templateId} ---`);
      } catch (err) {
        console.error("--- [PDF Controller] Failed to log download:", err);
      }
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
  } catch (error) {
    console.error("--- [PDF Controller] Error:", error);
    res.status(500).json({
      message: "Failed to generate PDF",
      error: error.message,
      stack: error.stack,
    });
  }
};
