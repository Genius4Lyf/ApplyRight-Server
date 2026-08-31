const mongoose = require("mongoose");

const jobSchema = new mongoose.Schema(
  {
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
    // How much of the posting we actually got.
    //
    //   full   → the real job description, from the posting's structured data or its
    //            description container.
    //   teaser → a SUMMARY only (an og:description, or a container too thin to be the
    //            posting). An analysis run against this is an analysis of a blurb, so the
    //            UI offers the user a way to fill the gap instead of pretending otherwise.
    //   typed  → the user pasted or typed it themselves. Always complete by definition.
    descriptionQuality: {
      type: String,
      enum: ["full", "teaser", "typed"],
      default: "typed",
    },
    // Where the description came from, for diagnosing scrapes that come back thin.
    descriptionSource: {
      type: String,
      enum: ["structured", "dom", "meta", "typed"],
      default: "typed",
    },
    // What the posting stated about ITSELF, beyond its text — nearly all of it lifted
    // from the Schema.org JobPosting block sites publish for machines. Every field is
    // optional and absent when the posting didn't say: "not stated" and "we didn't look"
    // must stay distinguishable, so nothing here gets a default.
    details: {
      location: String,
      employmentType: String, // FULL_TIME, CONTRACTOR, …
      salary: String, // pre-formatted, e.g. "NGN 400,000–600,000 per MONTH"
      datePosted: String,
      validThrough: String,
      experienceRequirements: String,
      educationRequirements: String,
      industry: String,
    },
    analysis: {
      skills: [
        {
          name: String,
          importance: {
            type: Number, // 1-5
            default: 3,
          },
        },
      ],
      experience: {
        minYears: Number,
        preferredYears: Number,
      },
      education: {
        degree: String,
        fields: [String],
      },
      seniority: {
        type: String, // entry, mid, senior, lead, executive
        enum: ["entry", "mid", "senior", "lead", "executive", "unknown"],
        default: "unknown",
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Job", jobSchema);
