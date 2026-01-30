const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
    },
    password: {
        type: String,
        required: true,
    },
    plan: {
        type: String,
        enum: ['free', 'paid'],
        default: 'free',
    },
    credits: {
        type: Number,
        default: 20, // Free starting credits
    },
    firstName: {
        type: String,
        default: '',
    },
    lastName: {
        type: String,
        default: '',
    },
    otherName: {
        type: String,
        default: '',
    },
    phone: {
        type: String,
        default: '',
    },
    portfolioUrl: {
        type: String,
        default: '',
    },
    linkedinUrl: {
        type: String,
        default: '',
    },
    currentJobTitle: {
        type: String,
        default: '',
    },
    currentStatus: {
        type: String,
        enum: ['student', 'graduate', 'professional', 'other'],
    },
    education: {
        university: String,
        discipline: String,
        graduationYear: String,
    },
    careerGoals: [{
        type: String,
    }],
    skills: [{
        type: String,
    }],
    onboardingCompleted: {
        type: Boolean,
        default: false,
    },
    settings: {
        autoGenerateAnalysis: {
            type: Boolean,
            default: false,
        },
        showOnboardingTutorials: {
            type: Boolean,
            default: true,
        },
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('User', userSchema);
