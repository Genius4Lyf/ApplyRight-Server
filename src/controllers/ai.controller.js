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
        const { questionsToAnswer: interviewQuestions, questionsToAsk } = await generateInterviewQuestions(job.description, []);

        if (application) {
            // Update existing
            application.optimizedCV = optimizedCV;
            application.coverLetter = coverLetter;
            application.templateId = templateId || 'ats-clean';
            application.interviewQuestions = interviewQuestions;
            application.questionsToAsk = questionsToAsk;
            await application.save();
        } else {
            // Create new
            application = await Application.create({
                userId: req.user.id,
                resumeId,
                jobId,
                optimizedCV,
                coverLetter,
                templateId: templateId || 'ats-clean',
                interviewQuestions: interviewQuestions,
                questionsToAsk: questionsToAsk
            });
        }

        res.status(201).json(application);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to generate application' });
    }
};

// @desc    Generate bullet points or summary
// @route   POST /api/ai/generate-bullets
// @access  Private
const generateBullets = async (req, res) => {
    const { role, context, type, targetJob } = req.body;

    // Basic validation
    if (!role && !context) {
        return res.status(400).json({ message: 'Please provide role/title and some context.' });
    }

    try {
        const suggestions = await require('../services/ai.service').generateBulletPoints(role, context, type, targetJob);
        res.json({ suggestions });
    } catch (error) {
        console.error("Bullet Gen Error:", error);
        res.status(500).json({ message: 'Failed to generate suggestions' });
    }
};

// @desc    Generate categorized skills from profile context
// @route   POST /api/ai/generate-skills
// @access  Private
const generateSkills = async (req, res) => {
    const { education, experience, projects, targetJob } = req.body;
    const SKILLS_COST = 2;

    try {
        const user = await require('../models/User').findById(req.user.id);

        if (user.credits < SKILLS_COST) {
            return res.status(403).json({
                message: 'Insufficient credits',
                code: 'INSUFFICIENT_CREDITS',
                required: SKILLS_COST,
                current: user.credits
            });
        }

        const suggestions = await require('../services/ai.service').generateSkillsFromContext(
            education || [],
            experience || [],
            projects || [],
            targetJob || ''
        );

        // Deduct credits
        user.credits -= SKILLS_COST;
        await user.updateOne({ credits: user.credits });

        // Record Transaction
        await require('../models/Transaction').create({
            userId: user.id,
            amount: -SKILLS_COST,
            type: 'usage',
            description: 'AI Skills Generation users profile context',
            status: 'completed'
        });

        res.json({
            suggestions,
            remainingCredits: user.credits
        });

    } catch (error) {
        console.error("Skills Gen Error:", error);
        res.status(500).json({ message: 'Failed to generate skills' });
    }
};

module.exports = {
    generateApplication,
    generateBullets,
    generateSkills,
};
