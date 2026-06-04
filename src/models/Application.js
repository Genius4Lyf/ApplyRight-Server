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
    // DEPRECATED — superseded by `interviewPrep.jobQuestions` and
    // `interviewPrep.questionsToAsk`. Kept for backward compatibility with
    // applications generated before the unified Interview Prep schema landed.
    // New analyses no longer write to these fields.
    interviewQuestions: [
      {
        type: { type: String },
        question: String,
      },
    ],
    questionsToAsk: [String],

    // Unified Interview Prep — combines two sources:
    //   - Skill-based prep: per-skill evidence + STAR-shaped talking point.
    //     Populated when the user clicks "Save to Interview Prep" on the CV
    //     builder Skills page.
    //   - Job-based prep: AI-generated questions WITH suggested answers, all
    //     grounded in the user's full profile (work history + education +
    //     projects + skills) and the JD. Populated automatically during the
    //     analysis flow.
    interviewPrep: {
      isSaved: { type: Boolean, default: false },
      savedAt: { type: Date },
      skillsWithEvidence: [
        {
          name: String,
          category: String,
          evidence: [
            {
              type: { type: String }, // 'experience' | 'education' | 'project'
              refIndex: Number,
              snippet: String,
            },
          ],
          talkingPoint: String,
          // Per-skill self-rated readiness from practice mode. Same enum as
          // question-level confidence so the UI can reuse the chips.
          confidence: {
            type: String,
            enum: ["needs_work", "almost", "ready"],
          },
        },
      ],
      jobQuestions: [
        {
          type: { type: String }, // 'technical' | 'behavioral' | 'situational'
          question: String,
          suggestedAnswer: String,
          sourcedFrom: [
            {
              type: { type: String },
              refIndex: Number,
            },
          ],
          confidence: {
            type: String,
            enum: ["needs_work", "almost", "ready"],
          },
          // Mock-answer grading history. Bounded to the last 10 attempts; the
          // stored answer is truncated (see gradeAnswer) so the doc — and the
          // prep list payload — can't balloon. Drives "Best X% · N attempts".
          attempts: [
            {
              score: Number,
              answer: String,
              createdAt: { type: Date, default: Date.now },
            },
          ],
        },
      ],
      questionsToAsk: [String],
      // Per-question fact-check flags from factCheckInterviewQuestions. Indexed
      // by jobQuestions[].index, with the unsupported claims the checker
      // found. Empty/absent = the suggestedAnswers are clean. Advisory only —
      // never deletes or blocks content, just lets the UI render a warning.
      fabricationWarnings: [
        {
          index: Number,
          unsupportedClaims: [String],
        },
      ],
      // Story Bank — reusable STAR stories drawn from the candidate's real
      // history, each mapping to multiple interview questions. Unlike
      // skillsWithEvidence / jobQuestions (re-derived and matched by name/text),
      // stories are AI-authored once then rated/edited over time, so they carry
      // a stable `id`. Generated on demand via /analysis/:id/generate-stories.
      stories: [
        {
          id: { type: String },
          title: String,
          theme: {
            type: String,
            enum: [
              "leadership",
              "problem_solving",
              "conflict",
              "technical_achievement",
              "failure_learning",
              "teamwork",
              "impact",
            ],
          },
          situation: String,
          task: String,
          action: String,
          result: String,
          skillsProven: [String],
          // Question themes/phrasings this story can answer — the explicit
          // backref that replaces the old substring skill→question matching.
          answersQuestions: [String],
          sourcedFrom: [
            {
              type: { type: String },
              refIndex: Number,
            },
          ],
          confidence: {
            type: String,
            enum: ["needs_work", "almost", "ready"],
          },
        },
      ],
      // Mirror of fabricationWarnings, indexed by stories[].index. Cleared for a
      // story once the user edits its STAR text (their own words don't need it).
      storyFabricationWarnings: [
        {
          index: Number,
          unsupportedClaims: [String],
        },
      ],
      // Result of the most recent Interview Mode session (timed simulation +
      // self-assessment). Overwritten each run; drives the "Last interview" review.
      lastInterviewSession: {
        completedAt: { type: Date },
        confidence: { type: String, enum: ["needs_work", "almost", "ready"] },
        durationSec: Number,
        plannedSec: Number,
        flagged: [{ index: Number, question: String }],
      },
      // Multi-note model. Legacy single-string notes are folded into a single
      // saved note on read (see interviewPrep.controller.js) so reads stay
      // backward-compatible without a destructive migration. Use Mixed so
      // either shape persists on save.
      userNotes: mongoose.Schema.Types.Mixed,
    },
    // Bundle-level warnings surfaced when one stage of the all-in-one
    // generation pipeline was skipped for a non-error reason (e.g. interview
    // prep skipped because the CV had no work-history to ground answers in).
    // The bundle still succeeds; the UI can render the warning so the user
    // knows what to do next.
    bundleWarnings: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Application", applicationSchema);
