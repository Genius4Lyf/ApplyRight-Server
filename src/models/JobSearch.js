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
    clicked: { type: Boolean, default: false },
    clickedAt: Date,
  },
  { _id: true }
);

const jobSearchSchema = new mongoose.Schema(
  {
    query: {
      keywords: String,
      location: String,
      country: String,
      jobType: String,
      remote: { type: Boolean, default: false },
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

jobSearchSchema.index({ createdAt: -1 });
jobSearchSchema.index({
  "query.keywords": 1,
  "query.country": 1,
  "query.location": 1,
  "query.jobType": 1,
  "query.remote": 1,
  source: 1,
  cachedUntil: 1,
});

module.exports = mongoose.model("JobSearch", jobSearchSchema);
