const Job = require('../models/Job');
const Resume = require('../models/Resume');
const Application = require('../models/Application');
const extractionService = require('../services/extraction.service');
const scoringService = require('../services/scoring.service');

const aiService = require('../services/ai.service');

const analyzeFit = async (req, res) => {
    try {
        const { jobId, resumeId, templateId } = req.body;
        const userId = req.user._id; // Assuming auth middleware

        // 1. Fetch Data
        const job = await Job.findById(jobId);
        const resume = await Resume.findById(resumeId);

        if (!job || !resume) {
            return res.status(404).json({ message: 'Job or Resume not found' });
        }

        // 2. Perform Extraction (if not already done)
        if (!job.analysis || job.analysis.skills.length === 0) {
            const extractedJob = extractionService.extractRequirements(job.description);
            job.analysis = extractedJob;
            await job.save();
        }

        // 3. AI Analysis (replaces old manual extraction + scoringService logic if AI is active)
        // We get a smarter profile analysis from the AI
        const aiResult = await aiService.analyzeProfile(resume.rawText, job.description);

        // Update Job Metadata if AI detects better info and current info is generic or missing
        if (aiResult.detectedJobTitle) {
            // Heuristic: Update if current title is generic OR if we trust AI more.
            // Let's trust AI to refine it.
            job.title = aiResult.detectedJobTitle;
            if (aiResult.detectedCompany && aiResult.detectedCompany !== 'Unknown Company') {
                job.company = aiResult.detectedCompany;
            }
            await job.save();
        }

        // Map AI result to our standard format
        let fitScore = aiResult.fitScore;
        let fitAnalysis = {
            overallFeedback: aiResult.reasoning || "Analysis complete.",
            skillsGap: aiResult.missingSkills || [],

            // Use AI detailed analysis if available, otherwise fallback to simple heuristics
            experienceMatch: aiResult.experienceAnalysis?.match ?? (aiResult.experienceYears >= (job.analysis?.experience?.minYears || 0)),
            experienceFeedback: aiResult.experienceAnalysis?.feedback || (aiResult.experienceYears >= (job.analysis?.experience?.minYears || 0) ? "Meets requirements" : "Less than preferred"),

            seniorityMatch: aiResult.seniorityAnalysis?.match ?? true,
            seniorityFeedback: aiResult.seniorityAnalysis?.feedback || "Aligned with role",

            recommendation: aiResult.recommendation,
            mode: aiResult.mode // "AI" or "Standard"
        };

        // 3b. Generate Smart Action Plan
        // If AI provided an action plan, use it. Otherwise fallback to hardcoded actions.
        const actionPlan = aiResult.actionPlan || scoringService.generateActionPlan(fitAnalysis.skillsGap);

        // 3c. Generate Professional Assets (NEW: merged into analysis flow)
        // We use the same service that was used in the separate /generate endpoint
        const { optimizedCV, coverLetter } = await aiService.generateOptimizedContent(resume.rawText, job.description, {
            graduationYear: req.user.graduationYear
        });

        const { questionsToAnswer: interviewQuestions, questionsToAsk } = await aiService.generateInterviewQuestions(job.description, []);

        // 4. Save/Update Application Record
        let application = await Application.findOne({ userId, jobId, resumeId });

        if (!application) {
            application = new Application({
                userId,
                jobId,
                resumeId,
                fitScore: fitScore,
                fitAnalysis: fitAnalysis,
                actionPlan: actionPlan,
                optimizedCV: optimizedCV,
                coverLetter: coverLetter,
                interviewQuestions: interviewQuestions,
                questionsToAsk: questionsToAsk, // NEW
                templateId: templateId || 'ats-clean' // Default template
            });
        } else {
            application.fitScore = fitScore;
            application.fitAnalysis = fitAnalysis;
            application.actionPlan = actionPlan;
            // Only update assets if they haven't been customized? 
            // For now, we overwrite on re-analysis to keep fresh with the new analysis
            application.optimizedCV = optimizedCV;
            application.coverLetter = coverLetter;
            application.interviewQuestions = interviewQuestions;
            application.questionsToAsk = questionsToAsk; // NEW
            if (templateId) application.templateId = templateId;
        }

        await application.save();

        // 5. Return Result
        res.status(200).json({
            fitScore: fitScore,
            fitAnalysis: fitAnalysis,
            actionPlan: actionPlan,
            optimizedCV: optimizedCV,
            coverLetter: coverLetter,
            interviewQuestions: interviewQuestions,
            questionsToAsk: questionsToAsk,
            applicationId: application._id,
            templateId: application.templateId,
            job: job // NEW: Return updated job details
        });

    } catch (error) {
        console.error('Analysis Error:', error);
        res.status(500).json({ message: 'Failed to analyze fit', error: error.message });
    }
};

module.exports = {
    analyzeFit
};
