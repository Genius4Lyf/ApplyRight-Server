const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    resumeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Resume',
        required: true,
    },
    jobId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Job',
        required: true,
    },
    fitScore: {
        type: Number,
        min: 0,
        max: 100
    },
    fitAnalysis: {
        overallFeedback: String,
        skillsGap: [String],
        experienceMatch: Boolean,
        educationMatch: Boolean,
        seniorityMatch: Boolean,
        recommendation: String
    },
    optimizedCV: {
        type: String, // Markdown or HTML content
    },
    coverLetter: {
        type: String, // Markdown or HTML content
    },
    exportCount: {
        type: Number,
        default: 0,
    },
    templateId: {
        type: String,
        default: 'modern'
    },
    actionPlan: [{
        skill: String,
        action: String
    }],
    interviewQuestions: [{
        type: { type: String }, // 'technical', 'behavioral'
        question: String
    }]
}, {
    timestamps: true,
});

module.exports = mongoose.model('Application', applicationSchema);
