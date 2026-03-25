const { parseResume } = require("../services/resumeParser.service");
const aiService = require("../services/ai.service");
const Resume = require("../models/Resume");
const DraftCV = require("../models/DraftCV");
const Transaction = require("../models/Transaction");
const fs = require("fs");

const UPLOAD_CREATE_COST = 15;

/**
 * Compute a lightweight ATS readiness score from extracted data.
 * No AI calls — pure deterministic checks on completeness and quality.
 * Returns { score: 0-100, checks: [...], tips: [...] }
 */
const computeATSReadiness = (extractedData, draft) => {
  const checks = [];
  const tips = [];
  let totalPoints = 0;
  let earnedPoints = 0;

  // 1. Professional Summary (15 pts)
  totalPoints += 15;
  const summary = draft.professionalSummary || "";
  if (summary.length >= 100) {
    earnedPoints += 15;
    checks.push({ label: "Professional summary", passed: true });
  } else if (summary.length > 0) {
    earnedPoints += 8;
    checks.push({ label: "Professional summary", passed: false, detail: "Too short" });
    tips.push("Expand your professional summary to 3-4 sentences highlighting your key strengths and career goals.");
  } else {
    checks.push({ label: "Professional summary", passed: false, detail: "Missing" });
    tips.push("Add a professional summary — it's the first thing recruiters and ATS systems scan.");
  }

  // 2. Work Experience (25 pts)
  totalPoints += 25;
  const exp = draft.experience || [];
  if (exp.length >= 2) {
    earnedPoints += 10;
    checks.push({ label: "Work experience entries", passed: true, detail: `${exp.length} roles` });
  } else if (exp.length === 1) {
    earnedPoints += 5;
    checks.push({ label: "Work experience entries", passed: false, detail: "Only 1 role" });
    tips.push("Add more work experience if available — most ATS systems rank resumes with 2+ roles higher.");
  } else {
    checks.push({ label: "Work experience entries", passed: false, detail: "Missing" });
    tips.push("Add work experience to strengthen your resume.");
  }

  // Check bullet quality (action verbs, quantification)
  totalPoints += 0; // Sub-check under experience
  const allBullets = exp.flatMap((e) => (e.description || "").split("\n").filter((b) => b.trim()));
  const bulletsWithNumbers = allBullets.filter((b) => /\d+/.test(b));
  if (allBullets.length > 0) {
    const quantifiedRatio = bulletsWithNumbers.length / allBullets.length;
    if (quantifiedRatio >= 0.3) {
      earnedPoints += 15;
      checks.push({ label: "Quantified achievements", passed: true, detail: `${bulletsWithNumbers.length}/${allBullets.length} bullets include metrics` });
    } else if (quantifiedRatio > 0) {
      earnedPoints += 8;
      checks.push({ label: "Quantified achievements", passed: false, detail: `Only ${bulletsWithNumbers.length}/${allBullets.length} bullets include metrics` });
      tips.push("Add numbers and metrics to more bullet points (e.g., 'Increased sales by 25%' instead of 'Increased sales').");
    } else {
      checks.push({ label: "Quantified achievements", passed: false, detail: "No metrics found" });
      tips.push("Quantify your achievements with numbers, percentages, or dollar amounts to stand out in ATS screening.");
    }
  }

  // 3. Skills (20 pts)
  totalPoints += 20;
  const skills = draft.skills || [];
  if (skills.length >= 8) {
    earnedPoints += 20;
    checks.push({ label: "Skills listed", passed: true, detail: `${skills.length} skills` });
  } else if (skills.length >= 4) {
    earnedPoints += 12;
    checks.push({ label: "Skills listed", passed: false, detail: `${skills.length} skills — aim for 8+` });
    tips.push("Add more relevant skills. ATS systems match keywords from job descriptions against your skills section.");
  } else {
    earnedPoints += skills.length > 0 ? 5 : 0;
    checks.push({ label: "Skills listed", passed: false, detail: skills.length > 0 ? `Only ${skills.length} skills` : "Missing" });
    tips.push("Add a comprehensive skills section — this is critical for ATS keyword matching.");
  }

  // 4. Education (10 pts)
  totalPoints += 10;
  const edu = draft.education || [];
  if (edu.length > 0) {
    earnedPoints += 10;
    checks.push({ label: "Education", passed: true, detail: `${edu.length} entries` });
  } else {
    checks.push({ label: "Education", passed: false, detail: "Missing" });
    tips.push("Add your education details — many ATS systems filter by degree requirements.");
  }

  // 5. Contact Info (15 pts)
  totalPoints += 15;
  const info = draft.personalInfo || {};
  const hasName = !!info.fullName && info.fullName !== "Candidate";
  const hasEmail = !!info.email;
  const hasPhone = !!info.phone;
  const hasLinkedIn = !!info.linkedin;
  const contactScore = [hasName, hasEmail, hasPhone, hasLinkedIn].filter(Boolean).length;
  if (contactScore >= 3) {
    earnedPoints += 15;
    checks.push({ label: "Contact information", passed: true });
  } else if (contactScore >= 2) {
    earnedPoints += 10;
    checks.push({ label: "Contact information", passed: false, detail: "Incomplete" });
    tips.push("Add your phone number and LinkedIn URL — recruiters need multiple ways to reach you.");
  } else {
    earnedPoints += 5;
    checks.push({ label: "Contact information", passed: false, detail: "Minimal" });
    tips.push("Complete your contact details: full name, email, phone, and LinkedIn profile.");
  }

  // 6. Projects (15 pts — bonus but valuable)
  totalPoints += 15;
  const projects = draft.projects || [];
  if (projects.length > 0) {
    earnedPoints += 15;
    checks.push({ label: "Projects", passed: true, detail: `${projects.length} projects` });
  } else {
    checks.push({ label: "Projects", passed: false, detail: "None listed" });
    tips.push("Consider adding relevant projects to showcase practical skills and initiative.");
  }

  const score = Math.round((earnedPoints / totalPoints) * 100);

  return { score, checks, tips };
};

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

  // 1. Check credits BEFORE doing any expensive work
  if (user.credits < UPLOAD_CREATE_COST) {
    cleanupUploadedFile(filePath);
    return res.status(403).json({
      message: "Insufficient credits",
      code: "INSUFFICIENT_CREDITS",
      required: UPLOAD_CREATE_COST,
      current: user.credits,
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
    const structuredSkills = await aiService.generateStructuredSkills({
      education: extractedData.education,
      experience: extractedData.experience,
      projects: extractedData.projects,
      targetJob: null,
    });

    // 5. Deduct credits only after all AI work succeeds
    user.credits -= UPLOAD_CREATE_COST;
    await user.updateOne({ credits: user.credits });

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

    // 10. Record transaction for audit trail
    await Transaction.create({
      userId: user._id,
      amount: -UPLOAD_CREATE_COST,
      type: "usage",
      description: "Create CV from uploaded resume",
      status: "completed",
    });

    // 11. Cleanup temp file
    cleanupUploadedFile(filePath);

    res.status(201).json({
      message: "Resume parsed and optimized successfully",
      draftId: draft._id,
      resumeId: resume._id,
      remainingCredits: user.credits,
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
