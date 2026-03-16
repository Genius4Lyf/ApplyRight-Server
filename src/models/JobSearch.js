const mongoose = require("mongoose");

const jobResultSchema = new mongoose.Schema(
  {
    externalId: String,
    source: { type: String, enum: ["adzuna", "jobberman"] },
    title: String,
    company: String,
    location: String,
    salary: String,
    snippet: String,
    fullDescription: { type: String, default: "" },
    applyUrl: String,
    category: String,
    postedDate: Date,
    matchScore: { type: Number, default: null },
    matchBreakdown: {
      skillsScore: { type: Number, default: null },
      experienceScore: { type: Number, default: null },
      locationScore: { type: Number, default: null },
      titleScore: { type: Number, default: null },
    },
    clicked: { type: Boolean, default: false },
    clickedAt: Date,
    saved: { type: Boolean, default: false },
  },
  { _id: true }
);

const jobSearchSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    query: {
      keywords: String,
      location: String,
      country: String,
      jobType: String,
      remote: { type: Boolean, default: false },
    },
    sourceCV: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DraftCV",
    },
    source: {
      type: String,
      enum: ["adzuna", "jobberman", "mixed", "global", "local"],
      default: "mixed",
    },
    results: [jobResultSchema],
    resultCount: { type: Number, default: 0 },
    cachedUntil: Date,
  },
  {
    timestamps: true,
  }
);

jobSearchSchema.index({ userId: 1, createdAt: -1 });
jobSearchSchema.index({ "query.keywords": 1, "query.country": 1 });

module.exports = mongoose.model("JobSearch", jobSearchSchema);
