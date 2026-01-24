const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
    jobUrl: {
        type: String,
    },
    title: {
        type: String,
        required: true,
    },
    company: {
        type: String,
        required: true,
    },
    description: {
        type: String,
        required: true,
    },
    keywords: {
        type: [String], // Array of keywords
    },
    analysis: {
        skills: [{
            name: String,
            importance: {
                type: Number, // 1-5
                default: 3
            }
        }],
        experience: {
            minYears: Number,
            preferredYears: Number
        },
        education: {
            degree: String,
            fields: [String]
        },
        seniority: {
            type: String, // entry, mid, senior, lead, executive
            enum: ['entry', 'mid', 'senior', 'lead', 'executive', 'unknown'],
            default: 'unknown'
        }
    },
}, {
    timestamps: true,
});

module.exports = mongoose.model('Job', jobSchema);
