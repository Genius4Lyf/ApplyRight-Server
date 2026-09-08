const mongoose = require("mongoose");

const jobResultSchema = new mongoose.Schema(
  {
    externalId: String,
    // "adzuna" is RETIRED and no new row will carry it — but it stays in the enum
    // because rows cached before its removal still do, and `getJobDetails` /
    // `trackClick` call `.save()` on those documents by id. Tightening the enum would
    // turn a user clicking Apply on an old cached listing into a validation error, i.e.
    // a 500 on the one button that matters. The service strips these on read instead.
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
    // Which filter produced this cached set. "adzuna" and "global" are retired and
    // never written now; kept for the same save-compatibility reason as above.
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
