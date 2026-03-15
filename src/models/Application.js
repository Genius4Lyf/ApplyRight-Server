const mongoose = require("mongoose");

const applicationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    resumeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Resume",
      required: true,
    },
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Job",
      required: true,
    },
    fitScore: {
      type: Number,
      min: 0,
      max: 100,
    },
    fitAnalysis: {
      overallFeedback: String,
      recommendation: String,
      mode: String, // 'AI' or 'Standard'
      matchedSkills: [
        {
          name: String,
          importance: { type: String, enum: ["must_have", "nice_to_have"] },
        },
      ],
      missingSkills: [
        {
          name: String,
          importance: { type: String, enum: ["must_have", "nice_to_have"] },
        },
      ],
      experienceAnalysis: {
        candidateYears: Number,
        requiredYears: Number,
        match: Boolean,
        feedback: String,
      },
      seniorityAnalysis: {
        candidateLevel: String,
        requiredLevel: String,
        match: Boolean,
        feedback: String,
      },
      scoreBreakdown: {
        skillsScore: Number,
        experienceScore: Number,
        educationScore: Number,
        seniorityScore: Number,
        overallScore: Number,
      },
    },
    optimizedCV: {
      type: String, // Markdown (backwards compatibility)
    },
    draftCVId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DraftCV",
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
      default: "ats-clean",
    },
    skills: [
      {
        name: String,
        category: String,
      },
    ],
    actionPlan: [
      {
        task: String,
        skill: String,
        importance: { type: String, enum: ["must_have", "nice_to_have"] },
        action: String,
        category: String,
      },
    ],
    interviewQuestions: [
      {
        type: { type: String }, // 'technical', 'behavioral'
        question: String,
      },
    ],
    questionsToAsk: [String],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Application", applicationSchema);
