const DocxService = require("../services/docx.service");
const subscription = require("../services/subscription.service");

exports.generateCvDocx = async (req, res) => {
  console.log("--- [DOCX Controller] Generate Request Received ---");
  try {
    const { markdown, userProfile } = req.body;

    if (!markdown) {
      console.warn("--- [DOCX Controller] Missing markdown content in request ---");
      return res.status(400).json({ message: "CV markdown content is required" });
    }

    // Download entitlement (WEB only). The native app keeps its own AdMob-rewarded
    // download model, so native requests are exempt (see api.js X-Client-Platform).
    // On web: first download is free (lifetime taste); after that a ₦500 single-
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
            "Pay ₦500 to download this CV as an ATS-ready Word doc, or go unlimited with a plan.",
          code: "NEED_DOWNLOAD",
        });
      }
    }

    // Generate DOCX
    console.log("--- [DOCX Controller] Calling DocxService.generateDocx... ---");
    let buffer;
    try {
      buffer = await DocxService.generateDocx(markdown, userProfile || {});
    } catch (genErr) {
      // Generation failed → give the download unit back.
      await subscription.refundDownload(req.user, consumed.method).catch(() => {});
      throw genErr;
    }
    console.log("--- [DOCX Controller] DOCX Generation Successful. Buffer size:", buffer.length);

    // Send DOCX response
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename="cv-${Date.now()}.docx"`,
    });

    res.send(buffer);
    console.log("--- [DOCX Controller] Response sent ---");

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
        console.log(`--- [DOCX Controller] Logged download for template: ${templateId} ---`);
      } catch (err) {
        console.error("--- [DOCX Controller] Failed to log download:", err);
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
    console.error("--- [DOCX Controller] Error:", error);
    res.status(500).json({
      message: "Failed to generate DOCX",
      error: error.message,
      stack: error.stack,
    });
  }
};
