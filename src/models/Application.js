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
    // Re-scored fit after CV optimization runs. Stored alongside the original
    // fitScore so the UI can surface a before → after delta as the "magic
    // moment" of CV generation.
    optimizedFitScore: {
      type: Number,
      min: 0,
      max: 100,
    },
    // User-facing application status. Auto-bumps from "analyzed" to
    // "assets_generated" when the user generates a CV. All later transitions
    // (submitted, interviewing, offer, rejected, withdrawn) are user-driven
    // via the JobHistory status menu.
    status: {
      type: String,
      enum: [
        "analyzed",
        "assets_generated",
        "submitted",
        "interviewing",
        "offer",
        "rejected",
        "withdrawn",
      ],
      default: "analyzed",
    },
    statusUpdatedAt: {
      type: Date,
      default: Date.now,
    },
    // CV-generation progress. The pipeline runs asynchronously after the user
    // clicks "Generate CV" — the controller returns 202 immediately and writes
    // stage updates here as it advances. Frontend polls /applications/:id and
    // renders these as a determinate progress bar.
    //
    // stage: 'idle' until generation starts; transitions through extracting →
    // scoring → enhancing → categorizing → assembling; ends in 'completed' or
    // 'failed'. Only transition into a non-terminal state if the prior state
    // was terminal (idle | completed | failed) — guards against double-clicks.
    generationStatus: {
      stage: {
        type: String,
        enum: [
          "idle",
          "extracting",
          "scoring",
          "enhancing",
          "categorizing",
          "assembling",
          "completed",
          "failed",
        ],
        default: "idle",
      },
      stageMessage: { type: String },
      progress: { type: Number, min: 0, max: 100, default: 0 },
      startedAt: { type: Date },
      completedAt: { type: Date },
      error: { type: String },
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
    jobTitle: String,
    jobCompany: String,
    coverLetter: {
      type: String, // Markdown or HTML content
    },
    // Fact-check warnings flagged by a post-generation LLM pass — claims in the
    // letter not directly supported by the resume. Empty array = clean letter.
    coverLetterWarnings: {
      type: [String],
      default: [],
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
