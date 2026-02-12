const Job = require('../models/Job');
const DraftCV = require('../models/DraftCV');
const Resume = require('../models/Resume');
const Application = require('../models/Application');
const extractionService = require('../services/extraction.service');
const scoringService = require('../services/scoring.service');

const aiService = require('../services/ai.service');

const analyzeFit = async (req, res) => {
    try {
        const { jobId, resumeId, templateId } = req.body;
        const userId = req.user._id;

        // Determine Cost based on operation type
        // If jobId is present -> Full Analysis (15 credits)
        // If jobId is missing -> Create/Upload Only (5 credits)
        const ANALYSIS_COST = jobId ? 15 : 5;

        // 0. Check Credit Balance
        const user = req.user; // Assuming user is fully attached by middleware
        if (user.credits < ANALYSIS_COST) {
            return res.status(403).json({
                message: 'Insufficient credits',
                code: 'INSUFFICIENT_CREDITS',
                required: ANALYSIS_COST,
                current: user.credits
            });
        }

        // 1. Fetch Data
        const job = jobId ? await Job.findById(jobId) : null;
        const resume = await Resume.findById(resumeId);

        if (!resume) {
            return res.status(404).json({ message: 'Resume not found' });
        }

        // NEW: Handle "Create from Upload" (No Job ID)
        if (!jobId) {
            // 1. Extract Data
            const extractedData = await aiService.extractResumeProfile(resume.rawText);

            // 2. Create Draft
            const draft = await DraftCV.create({
                userId,
                title: 'Uploaded Resume',
                personalInfo: {
                    fullName: req.user.firstName ? `${req.user.firstName} ${req.user.lastName}` : 'Candidate',
                    email: req.user.email
                },
                professionalSummary: extractedData.summary || '',
                experience: extractedData.experience?.map(e => ({
                    title: e.role,
                    company: e.company,
                    startDate: e.startDate,
                    endDate: e.endDate,
                    // If description is array, join distinct bullets. If string, use as is.
                    description: Array.isArray(e.description) ? e.description.map(d => `• ${d}`).join('\n') : (e.description || '')
                })) || [],
                education: extractedData.education?.map(e => ({
                    degree: e.degree,
                    school: e.school,
                    field: e.field,
                    graduationDate: e.date
                })) || [],
                projects: extractedData.projects?.map(p => ({
                    title: p.title,
                    link: p.link,
                    description: Array.isArray(p.description) ? p.description.map(d => `• ${d}`).join('\n') : (p.description || '')
                })) || [],
                skills: extractedData.skills || [],
                isComplete: true
            });

            // 3. Deduct Credits for Upload
            user.credits -= ANALYSIS_COST;
            await user.save();

            return res.status(200).json({
                message: 'Resume parsed successfully',
                draftId: draft._id,
                fitScore: null,
                fitAnalysis: null,
                remainingCredits: user.credits // Return new balance
            });
        }

        if (!job) {
            return res.status(404).json({ message: 'Job not found' });
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
        // 5. Deduct Credits
        user.credits -= ANALYSIS_COST;
        await user.save();

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
            job: job, // NEW: Return updated job details
            remainingCredits: user.credits // Return new balance
        });

    } catch (error) {
        console.error('Analysis Error Details:', {
            message: error.message,
            stack: error.stack,
            body: req.body,
            user: req.user ? req.user._id : 'No User'
        });
        res.status(500).json({
            message: 'Failed to analyze fit',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

module.exports = {
    analyzeFit
};
