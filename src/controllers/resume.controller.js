const { parseResume } = require('../services/resumeParser.service');
const Resume = require('../models/Resume');
const fs = require('fs');

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

        // Save to DB
        // Assuming req.user is populated by auth middleware
        const resume = await Resume.create({
            userId: req.user._id,
            rawText,
            parsedData: {}, // Placeholder for structured data extraction later
        });

        // Cleanup: delete uploaded file to save space? 
        // For MVP, we might want to keep it. But simplest is delete after extraction if we only care about text.
        // Let's keep it for now? No, let's delete to keep server stateless-ish.
        // Cleanup: delete uploaded file
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (cleanupErr) {
            console.warn('Failed to delete temp file:', cleanupErr.message);
        }

        res.status(201).json(resume);
    } catch (error) {
        console.error(error);
        // Clean up file if error
        try {
            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        } catch (cleanupErr) {
            console.warn('Failed to delete temp file in error handler:', cleanupErr.message);
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
