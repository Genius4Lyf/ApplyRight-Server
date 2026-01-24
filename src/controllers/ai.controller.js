const { generateOptimizedContent, generateInterviewQuestions } = require('../services/ai.service');
const Application = require('../models/Application');
const Resume = require('../models/Resume');
const Job = require('../models/Job');

// @desc    Generate optimized CV and Cover Letter
// @route   POST /api/ai/generate
// @access  Private
const generateApplication = async (req, res) => {
    const { resumeId, jobId, templateId } = req.body;

    if (!resumeId || !jobId) {
        return res.status(400).json({ message: 'Please provide resumeId and jobId' });
    }

    try {
        const resume = await Resume.findById(resumeId);
        const job = await Job.findById(jobId);

        if (!resume || !job) {
            return res.status(404).json({ message: 'Resume or Job not found' });
        }

        // Check if user owns the resume
        if (resume.userId.toString() !== req.user.id) {
            return res.status(401).json({ message: 'Not authorized to use this resume' });
        }

        // Check for existing application
        let application = await Application.findOne({ userId: req.user.id, jobId, resumeId });

        // Check Usage Limits ONLY if creating a NEW application
        if (!application && req.user.plan === 'free') {
            const applicationCount = await Application.countDocuments({ userId: req.user.id });
            if (applicationCount >= 2) {
                return res.status(403).json({ message: 'Free limit reached. Upgrade to Pro to create more applications.' });
            }
        }

        const { optimizedCV, coverLetter } = await generateOptimizedContent(resume.rawText, job.description, {
            graduationYear: req.user.graduationYear // Pass context
        });

        // Generate Interview Questions (NEW)
        // We use extracted skills + job description
        const interviewQuestions = await generateInterviewQuestions(job.description, []); // passing empty skills for now, service handles JD primarily

        if (application) {
            // Update existing
            application.optimizedCV = optimizedCV;
            application.coverLetter = coverLetter;
            application.templateId = templateId || 'modern';
            application.interviewQuestions = interviewQuestions;
            await application.save();
        } else {
            // Create new
            application = await Application.create({
                userId: req.user.id,
                resumeId,
                jobId,
                optimizedCV,
                coverLetter,
                templateId: templateId || 'modern',
                interviewQuestions: interviewQuestions
            });
        }

        res.status(201).json(application);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to generate application' });
    }
};

module.exports = {
    generateApplication,
};
