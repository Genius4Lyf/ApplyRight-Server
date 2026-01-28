const mongoose = require('mongoose');

const draftCVSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    title: {
        type: String,
        default: 'Untitled CV',
    },
    targetJob: {
        title: String,
        description: String, // Context for AI tailoring
    },
    personalInfo: {
        fullName: String,
        email: String,
        phone: String,
        address: String,
        linkedin: String,
        website: String,
    },
    professionalSummary: {
        type: String,
        default: '',
    },
    experience: [{
        title: String,
        company: String,
        startDate: String,
        endDate: String,
        isCurrent: Boolean,
        description: String, // Bullet points
    }],
    projects: [{
        title: String,
        link: String,
        description: String, // Bullet points
    }],
    education: [{
        degree: String,
        school: String,
        graduationDate: String,
        description: String,
    }],
    skills: [{
        type: String, // e.g. "JavaScript"
    }],
    isComplete: {
        type: Boolean,
        default: false,
    },
    currentStep: {
        type: String,
        default: 'target_job', // Store step ID so user can resume where they left off
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('DraftCV', draftCVSchema);
