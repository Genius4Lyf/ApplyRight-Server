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
        default: 30, // Free starting credits
    },
    adStreak: {
        current: { type: Number, default: 0 },
        longest: { type: Number, default: 0 },
        lastWatchDate: { type: Date, default: null },
    },
    unlockedTemplates: [String],
    referralCode: {
        type: String,
        unique: true,
        sparse: true, // Allows null/undefined values to not violate uniqueness (though we generate for all)
    },
    referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    referralCount: {
        type: Number,
        default: 0,
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
