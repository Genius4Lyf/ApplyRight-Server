const { parseResume } = require('../services/resumeParser.service');
const aiService = require('../services/ai.service');
const Resume = require('../models/Resume');
const fs = require('fs');

const cleanupUploadedFile = (filePath, logContext = '') => {
    if (!filePath) return;

    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (cleanupErr) {
        const contextSuffix = logContext ? ` ${logContext}` : '';
        console.warn(`Failed to delete temp file${contextSuffix}:`, cleanupErr.message);
    }
};

// @desc    Upload and parse resume
// @route   POST /api/resumes/upload
// @access  Private
const uploadResume = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Please upload a file' });
    }

    try {
        const filePath = req.file.path;
        const mimetype = req.file.mimetype;

        // Parse content
        const { rawText } = await parseResume(filePath, mimetype);

        if (!rawText || !rawText.trim()) {
            cleanupUploadedFile(filePath);
            return res.status(422).json({
                message: 'Could not extract text from the uploaded resume. Please upload a text-based PDF or DOCX.',
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

        cleanupUploadedFile(req.file?.path, 'in error handler');

        if (error.code === 'UNSUPPORTED_FILE_TYPE') {
            return res.status(400).json({
                message: 'Unsupported file type. Please upload a PDF or DOC/DOCX resume.',
            });
        }

        if (error.code === 'EMPTY_RESUME_TEXT') {
            return res.status(422).json({
                message: 'Could not extract text from the uploaded resume. Please upload a text-based PDF or DOCX.',
            });
        }

        if (error.name === 'ValidationError' && error.errors?.rawText?.kind === 'required') {
            return res.status(422).json({
                message: 'Resume text extraction failed. Please upload a readable, text-based resume file.',
            });
        }

        res.status(500).json({ message: 'Failed to process resume', error: error.message });
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
        res.status(500).json({ message: 'Failed to fetch resumes' });
    }
};

module.exports = {
    uploadResume,
    getResumes,
};
