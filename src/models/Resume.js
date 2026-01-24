const mongoose = require('mongoose');

const resumeSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    rawText: {
        type: String,
        required: true,
    },
    parsedData: {
        skills: [String],
        experience: [{
            years: Number,
            role: String,
            company: String
        }],
        education: [{
            degree: String,
            field: String,
            school: String
        }],
        seniority: String
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('Resume', resumeSchema);
