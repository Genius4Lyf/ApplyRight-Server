const { parseResume } = require("../services/resumeParser.service");
const aiService = require("../services/ai.service");
const subscription = require("../services/subscription.service");
const Resume = require("../models/Resume");
const DraftCV = require("../models/DraftCV");
const fs = require("fs");

const UPLOAD_CREATE_COST = 15;

// Lightweight, deterministic ATS readiness score (summary, experience, skills,
// etc.). Moved to atsCoach.service so the CV Builder coach panel and this upload
// flow share one implementation. See also the browser port at
// applyright-frontend/src/utils/cvHealth.js (live "CV Health" score).
const { computeATSReadiness } = require("../services/atsCoach.service");

const cleanupUploadedFile = (filePath, logContext = "") => {
  if (!filePath) return;

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (cleanupErr) {
    const contextSuffix = logContext ? ` ${logContext}` : "";
    console.warn(`Failed to delete temp file${contextSuffix}:`, cleanupErr.message);
  }
};

// @desc    Upload and parse resume
// @route   POST /api/resumes/upload
// @access  Private
const uploadResume = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Please upload a file" });
  }

  try {
    const filePath = req.file.path;
    const mimetype = req.file.mimetype;

    // Parse content
    const { rawText } = await parseResume(filePath, mimetype);

    if (!rawText || !rawText.trim()) {
      cleanupUploadedFile(filePath);
      return res.status(422).json({
        message:
          "Could not extract text from the uploaded resume. Please upload a text-based PDF or DOCX.",
      });
    }

    // Analyze using AI
    const parsedData = await aiService.extractResumeProfile(rawText);

    // Save to DB
    // Assuming req.user is populated by auth middleware
    const resume = await Resume.create({
      userId: req.user._id,
      rawText,
      parsedData: parsedData, // Store the structured data
    });

    // Cleanup: delete uploaded file to save space?
    // For MVP, we might want to keep it. But simplest is delete after extraction if we only care about text.
    // Let's keep it for now? No, let's delete to keep server stateless-ish.
    // Cleanup: delete uploaded file
    cleanupUploadedFile(filePath);

    res.status(201).json(resume);
  } catch (error) {
    console.error(error);

    cleanupUploadedFile(req.file?.path, "in error handler");

    if (error.code === "UNSUPPORTED_FILE_TYPE") {
      return res.status(400).json({
        message: "Unsupported file type. Please upload a PDF or DOC/DOCX resume.",
      });
    }

    if (error.code === "EMPTY_RESUME_TEXT") {
      return res.status(422).json({
        message:
          "Could not extract text from the uploaded resume. Please upload a text-based PDF or DOCX.",
      });
    }

    if (error.name === "ValidationError" && error.errors?.rawText?.kind === "required") {
      return res.status(422).json({
        message: "Resume text extraction failed. Please upload a readable, text-based resume file.",
      });
    }

    res.status(500).json({ message: "Failed to process resume", error: error.message });
  }
};

// @desc    Get all resumes for user
// @route   GET /api/resumes
// @access  Private
const getResumes = async (req, res) => {
  try {
    const resumes = await Resume.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json(resumes);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch resumes" });
  }
};

// @desc    Upload resume, parse it, and create a DraftCV in one atomic operation
// @route   POST /api/resumes/upload-and-create
// @access  Private
// @cost    15 credits
const uploadAndCreateDraft = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "Please upload a file" });
  }

  const user = req.user;
  const filePath = req.file.path;

  // 1. Check credits BEFORE doing any expensive work. Paid tiers draw from their
  // per-period allowance first, then the wallet (combined available balance).
  if (subscription.availableCredits(user) < UPLOAD_CREATE_COST) {
    cleanupUploadedFile(filePath);
    return res.status(403).json({
      message: "Insufficient credits",
      code: "INSUFFICIENT_CREDITS",
      required: UPLOAD_CREATE_COST,
      current: subscription.availableCredits(user),
    });
  }

  try {
    // 2. Parse the file to extract raw text
    const mimetype = req.file.mimetype;
    const { rawText } = await parseResume(filePath, mimetype);

    if (!rawText || !rawText.trim()) {
      cleanupUploadedFile(filePath);
      return res.status(422).json({
        message:
          "Could not extract text from the uploaded resume. Please upload a text-based PDF or DOCX.",
      });
    }

    // 3. AI extraction (single call — no duplication)
    const extractedData = await aiService.extractResumeProfile(rawText);

    // 4. Generate structured skills
    const structuredSkills = await aiService.generateStructuredSkills(
      {
        education: extractedData.education,
        experience: extractedData.experience,
        projects: extractedData.projects,
        targetJob: null,
      },
      { model: aiService.resolveTextModel(user) }
    );

    // 5. Deduct credits only after all AI work succeeds. spendCredits draws from
    // the tier allowance first, then the wallet, and records the Transaction.
    const charge = await subscription.spendCredits(user, UPLOAD_CREATE_COST, {
      type: "usage",
      description: "Create CV from uploaded resume",
    });

    // 6. Save Resume record
    const resume = await Resume.create({
      userId: user._id,
      rawText,
      parsedData: extractedData,
    });

    // 7. Build draft data — CV-extracted contact info takes priority, user profile is fallback
    const cvContact = extractedData.contactInfo || {};
    const userFullName = user.firstName ? `${user.firstName} ${user.lastName}`.trim() : "";
    const draftData = {
      userId: user._id,
      title: "Uploaded Resume",
      source: "upload",
      personalInfo: {
        fullName: cvContact.fullName || userFullName || "Candidate",
        email: cvContact.email || user.email || "",
        phone: cvContact.phone || user.phone || "",
        linkedin: cvContact.linkedin || user.linkedinUrl || "",
        website: cvContact.website || user.portfolioUrl || "",
        address: cvContact.address || user.location || "",
      },
      professionalSummary: extractedData.summary || "",
      experience:
        extractedData.experience?.map((e) => ({
          title: e.role,
          company: e.company,
          startDate: e.startDate,
          endDate: e.endDate,
          description: Array.isArray(e.description)
            ? e.description.map((d) => `• ${d}`).join("\n")
            : e.description || "",
        })) || [],
      education:
        extractedData.education?.map((e) => ({
          degree: e.degree,
          school: e.school,
          field: e.field,
          graduationDate: e.date,
        })) || [],
      projects:
        extractedData.projects?.map((p) => ({
          title: p.title,
          link: p.link,
          description: Array.isArray(p.description)
            ? p.description.map((d) => `• ${d}`).join("\n")
            : p.description || "",
        })) || [],
      skills:
        structuredSkills && structuredSkills.length > 0
          ? structuredSkills.map((s) => ({ ...s, isAutoGenerated: true }))
          : (extractedData.skills || []).map((s) => ({
              name: s,
              category: "Uncategorized",
              isAutoGenerated: false,
            })),
      isComplete: true,
    };

    // 8. Create DraftCV
    const draft = await DraftCV.create(draftData);

    // 9. Compute ATS readiness score
    const atsReadiness = computeATSReadiness(extractedData, draft);

    // 10. (Transaction is recorded inside spendCredits above.)

    // 11. Cleanup temp file
    cleanupUploadedFile(filePath);

    res.status(201).json({
      message: "Resume parsed and optimized successfully",
      draftId: draft._id,
      resumeId: resume._id,
      remainingCredits: charge.remainingCredits,
      atsReadiness,
    });
  } catch (error) {
    console.error("Upload and create error:", error);
    cleanupUploadedFile(filePath, "in error handler");

    if (error.code === "UNSUPPORTED_FILE_TYPE") {
      return res.status(400).json({
        message: "Unsupported file type. Please upload a PDF or DOC/DOCX resume.",
      });
    }

    if (error.code === "EMPTY_RESUME_TEXT") {
      return res.status(422).json({
        message:
          "Could not extract text from the uploaded resume. Please upload a text-based PDF or DOCX.",
      });
    }

    if (error.name === "ValidationError" && error.errors?.rawText?.kind === "required") {
      return res.status(422).json({
        message: "Resume text extraction failed. Please upload a readable, text-based resume file.",
      });
    }

    res.status(500).json({ message: "Failed to process resume", error: error.message });
  }
};

module.exports = {
  uploadResume,
  uploadAndCreateDraft,
  getResumes,
};
