const mongoose = require("mongoose");

const draftCVSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Set when this draft was created via "Edit in Builder" on an Application.
    // Lets us short-circuit duplicate edit requests and recover from a dropped
    // connection: if the POST fails after the draft was already created, the
    // frontend can find it by sourceApplicationId instead of creating a duplicate.
    sourceApplicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Application",
      default: null,
      index: true,
    },
    title: {
      type: String,
      default: "Untitled CV",
    },
    source: {
      type: String,
      enum: ["upload", "scratch", "unknown"],
      default: "unknown",
    },
    exportCount: {
      type: Number,
      default: 0,
    },
    // CV Studio's selected presentation. Stored on the draft so reopening Studio
    // or returning from hosted checkout cannot silently fall back to ATS Clean.
    templateId: {
      type: String,
      default: "ats-clean",
    },
    targetJob: {
      title: String,
      description: String, // Context for AI tailoring
      // 'ai_drafted' when the JD came from Aria's "generate a typical role profile" assist rather
      // than a real posting the user pasted. The fit score, Role Brief and per-section
      // verdicts are all computed AGAINST the JD, so a synthetic one describes the
      // general role rather than a real posting — this lets the UI say so.
      source: {
        type: String,
        enum: ["pasted", "ai_drafted"],
        default: "pasted",
      },
      // Cached richer AI keyword extraction (the paid "Find more keywords"
      // action). Stored per CV so re-viewing a step never re-charges; the hash
      // of the job description it was derived from lets us detect a changed JD
      // and charge again only then.
      aiKeywords: [
        {
          name: String,
          importance: String, // 'must_have' | 'nice_to_have'
        },
      ],
      aiKeywordsHash: String,
      // Aria's Role Brief — the research object every AI feature reuses. Built
      // once from the JD (extractJobRequirements + an inferred companyType),
      // cached by briefHash so re-viewing a step never re-extracts; rebuilt only
      // when the JD text changes.
      brief: {
        role: String,
        company: String,
        companyType: String, // 'startup'|'enterprise'|'agency'|'nonprofit'|'government'|'smb'|'unknown' — INFERRED, user-confirmable
        companyTypeConfirmed: { type: Boolean, default: false }, // true once the student confirms/corrects the chip
        industry: String,
        seniority: String,
        yearsRequired: Number,
        // The minimum qualification the JD states, kept as its own typed field rather
        // than folded into mustHaves. scoringEngine.scoreEducation reads it directly on
        // every free recompute; without it declared here, strict mode would strip it on
        // save and the education score would silently fall back to "not stated".
        requiredEducation: {
          degree: String,
          field: String,
        },
        // `aliases` are the OTHER names this posting used for the same thing. They ride on
        // the compact arrays because these are what the scorer, the keyword-coverage
        // tracker and the "still uncovered" check all read — and without them those three
        // could only ever match the one canonical name, disagreeing with Aria (who reads
        // the typed `requirements` below) about the same word on the same screen.
        // Additive: briefs saved before this simply have none, and behave as they did.
        mustHaves: [{ name: String, importance: String, aliases: [String] }],
        niceToHaves: [{ name: String, importance: String, aliases: [String] }],
        responsibilities: [String],
        // Typed requirement checklist used by Aria's role-by-role interview. The
        // legacy mustHaves/niceToHaves arrays remain the scoring contract; this richer
        // list tells the coach WHAT a JD item is and what truthful evidence to look for.
        requirements: [
          {
            id: String,
            name: String,
            // `type` is also Mongoose's schema-type keyword. Nesting the declaration
            // makes this a real subdocument field instead of accidentally telling
            // Mongoose that each requirement is itself a String.
            type: { type: String }, // tool|technology|method|domain|certification|responsibility|skill
            priority: String, // must_have|nice_to_have
            explicit: { type: Boolean, default: true },
            aliases: [String],
            proofSignals: [String],
            sourceText: String,
            plausibleExperienceTypes: [String],
          },
        ],
      },
      briefHash: String,
      // The NO-job-description path. "Not yet — build a strong all-rounder" used to be a
      // chat line with no state behind it, so nothing downstream could honour the answer.
      // Lives on targetJob (not top-level) because every "is there a target?" reader
      // already looks here, and the moment a real JD arrives resolveDraftBrief wins and
      // this becomes history.
      //
      // `keywords` are INFERRED FROM A TITLE (inferRoleKeywords) — deliberately id-less,
      // so they can never be cited as requirements the way brief.requirements can.
      noJd: {
        declined: { type: Boolean, default: false },
        declinedAt: Date,
        roleFamily: String,
        keywords: [{ name: String, importance: String }],
        keywordsHash: String,
      },
    },
    // Cached "Auto-fill skills" generation. Keyed by a hash of the inputs the
    // generation depends on (education + experience + projects + target job), so
    // re-opening the modal or re-clicking returns the same set for free instead
    // of re-charging the user (and re-hitting the AI). Regenerated only when the
    // underlying profile actually changes. `bestForRole` is the deterministic
    // JD-match set (names) used to drive the paid "Best for this role" picks.
    // What people in the user's OWN roles/projects/certifications normally know — the
    // occupational vocabulary skills generation is grounded against. Cached separately
    // from skillsGenCache and keyed on the TITLES alone, so changing the skill count or
    // the model re-runs the generation without re-deriving the canon.
    skillCanonCache: {
      hash: String,
      roles: mongoose.Schema.Types.Mixed, // [{ id, label, source, refIndex, skills[] }]
    },
    skillsGenCache: {
      hash: String,
      suggestions: mongoose.Schema.Types.Mixed, // [{ category, skills[], skillsDetailed? }]
      bestForRole: [String],
      reviewGroups: mongoose.Schema.Types.Mixed,
    },
    personalInfo: {
      fullName: String,
      email: String,
      phone: String,
      address: String,
      linkedin: String,
      website: String,
      photoUrl: String,
      nationality: String,
    },
    professionalSummary: {
      type: String,
      default: "",
    },
    // The user's picked career stage for this CV ('experienced'|'grad'|'changer'), asked
    // once via Aria Studio's CareerStageAskCard. Persisted so a reload/session-resume
    // doesn't silently fall back to backend inference. No enum constraint — only ever
    // written by our own frontend.
    careerStage: {
      type: String,
      default: null,
    },
    experience: [
      {
        // Stable per-entry id the builder assigns (uuid). Declared here so it
        // survives Mongoose strict-mode saves — the ATS coach keys role-targeted
        // rewrites/red-flags off it, and it lets drag-reorder persist across reloads.
        _sortId: String,
        entryType: String,
        title: String,
        company: String,
        startDate: String,
        endDate: String,
        isCurrent: Boolean,
        description: String, // Bullet points
      },
    ],
    projects: [
      {
        _sortId: String, // see experience._sortId
        // The PROJECT's type — 'course' | 'personal' | 'work'. Symmetric with
        // experience.entryType (same field name, different value vocabulary) and used the
        // same way: it is forwarded to coachChatTurn so Aria KNOWS what kind of project
        // this is and frames the coaching by it, instead of having to draw it out of the
        // thread again. Persisting it on the ENTRY (rather than only as a transcript
        // marker) is what lets a TAILORED copy — projects is in the studio controller's
        // CLONED_CONTENT_FIELDS, so the type clones with the entry, no clone code change
        // needed — and an "Edit with Aria" interview see the type at all.
        entryType: String,
        title: String,
        link: String,
        description: String, // Bullet points
      },
    ],
    education: [
      {
        _sortId: String, // see experience._sortId
        degree: String,
        school: String,
        graduationDate: String,
        cgpa: String, // Free text: grading scales vary ("3.8/4.0", "4.5/5.0", "Second Class Upper")
        description: String,
      },
    ],
    // Certifications & training — a structural section the builder previously
    // lacked (Education only). High value for licence-gated trades/operations/
    // healthcare roles. Rendered into the CV markdown after Education.
    certifications: [
      {
        name: String,
        issuer: String,
        date: String,
      },
    ],
    skills: [
      {
        name: { type: String, required: true },
        category: { type: String, default: "Uncategorized" },
        isAutoGenerated: { type: Boolean, default: false },
        // Per-skill interview-prep metadata, populated when AI generates skills.
        // Used by the CV builder ⓘ popover and saved to Application.interviewPrep
        // (or DraftCV.interviewPrep when no application is linked yet).
        evidence: [
          {
            // 'experience' | 'education' | 'project', or 'user_confirmed' when the user
            // themselves vouched for it (the job-keyword honesty check). No enum, so the
            // client-written kind needs no migration.
            type: { type: String },
            refIndex: Number,
            snippet: String,
            // Set when the support came from Aria's work-history interview: the user's own
            // words, server-verified against a real turn. Persisted rather than derived so
            // the provenance survives a reload — Mongoose would otherwise strip both.
            sourceQuote: String,
            fromInterview: Boolean,
          },
        ],
        talkingPoint: String,
        explicitlyConfirmed: { type: Boolean, default: false },
        // A rung of the honesty ladder: 'direct' (uses it) | 'basic' (basic use).
        // 'encountered'/'no' are never added at all. Read by the skills ranker
        // (evidenceStrength) — for a long time this was written and read by nothing.
        confirmationStatus: String,
      },
    ],
    // Interview Prep saved against this CV when the user has no linked job
    // application yet (e.g., editing an uploaded CV or building from scratch
    // before running a job analysis). Same shape as Application.interviewPrep
    // but without job-context fields (jobQuestions / questionsToAsk).
    interviewPrep: {
      isSaved: { type: Boolean, default: false },
      savedAt: { type: Date },
      skillsWithEvidence: [
        {
          name: String,
          category: String,
          evidence: [
            {
              type: { type: String },
              refIndex: Number,
              snippet: String,
            },
          ],
          talkingPoint: String,
          confidence: {
            type: String,
            enum: ["needs_work", "almost", "ready"],
          },
        },
      ],
      // Parity with Application.interviewPrep.fabricationWarnings — populated
      // if a draft ever gets job-based prep saved against it (currently only
      // through the application path, but reserved for symmetry).
      fabricationWarnings: [
        {
          index: Number,
          unsupportedClaims: [String],
        },
      ],
      // Story Bank — parity with Application.interviewPrep.stories so CV-only
      // prep supports the same reusable STAR stories. See Application.js for the
      // field rationale.
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
      storyFabricationWarnings: [
        {
          index: Number,
          unsupportedClaims: [String],
        },
      ],
      // Parity with Application.interviewPrep.lastInterviewSession.
      lastInterviewSession: {
        completedAt: { type: Date },
        confidence: { type: String, enum: ["needs_work", "almost", "ready"] },
        score: Number,
        durationSec: Number,
        plannedSec: Number,
        flagged: [{ index: Number, question: String }],
        assessment: {
          overallScore: Number,
          readiness: { type: String, enum: ["needs_work", "almost", "ready"] },
          summary: String,
          dimensions: [{ key: String, label: String, score: Number, feedback: String }],
          strengths: [String],
          gaps: [String],
          nextSteps: [String],
          questionsAsked: [String],
        },
      },
      // Parity with Application.interviewPrep.interviewHistory (desensitization trend).
      interviewHistory: [
        {
          completedAt: { type: Date },
          confidence: { type: String, enum: ["needs_work", "almost", "ready"] },
          score: Number,
        },
      ],
      // Parity with Application.interviewPrep.dressGuide.
      dressGuide: {
        dressCode: { type: String },
        summary: String,
        wear: [String],
        avoid: [String],
        virtualTip: String,
        groomingNote: String,
        generatedAt: { type: Date },
      },
      // Mixed to support both the legacy single-string format and the new
      // multi-note array. The controller normalizes legacy string values into
      // a single saved note on read so the frontend only ever sees the array.
      userNotes: mongoose.Schema.Types.Mixed,
    },
    // Sections the user has marked NOT APPLICABLE to them (currently only 'projects' —
    // see config/sections.DISMISSABLE_SECTIONS). A dismissed section is excluded from the
    // section scan's verdicts AND from both sides of the ATS points budget, so a
    // candidate who has deliberately never had side projects stops being scored against
    // a section they will never fill.
    //
    // Plain [String] with NO enum: the whitelist is enforced on READ
    // (config/sections.dismissedSectionsOf), which covers narrow $set patches and legacy
    // documents alike. An enum here would only reject at the model layer — and
    // findByIdAndUpdate, which every draft save goes through, doesn't run validators
    // anyway, so it would be a guard that never fires.
    dismissedSections: [String],
    // Marks this draft as an Aria Studio SESSION, and which kind. Presence is the
    // marker; the value is the kind — one field doing both jobs.
    //
    // Deliberately NOT a new `source` enum value: admin.controller's Creation Method
    // analytics buckets drafts by `source` into upload vs scratch (admin.controller.js
    // ~100), so adding 'studio' there would silently reclassify every Studio draft in
    // that chart. Studio drafts keep source:'scratch' (which is what they are — typed,
    // not uploaded) and carry their Studio identity here instead.
    studioKind: {
      type: String,
      enum: ["tailor", "build"],
      default: null,
      index: true,
    },
    // Per-SESSION Aria model choice (config/catalog DEFAULT_MODELS id). Overrides the
    // user's default (User.aiModelId) for this draft only; null → fall back to the user
    // default → DEFAULT_MODEL. Set via POST /coach/model. Plain id (no enum) so new models
    // don't need a migration.
    studioModelId: {
      type: String,
      default: null,
    },
    // The source CV's title, denormalized at clone time. The session list shows
    // "from <source CV>", and a title read through tailoredFrom would break the moment
    // the user renames or deletes the original — this is a historical fact, not a live ref.
    tailoredFromTitle: String,
    // Aria Studio's scan snapshot — the last full AI analysis of this CV against its
    // target job, plus the deterministic per-section verdicts. Persisted so the Studio
    // (score card, section breakdown, artifact panel) restores on refresh without
    // re-charging. `jdHash` marks which JD it was scanned against, so a changed job can
    // be detected as stale. A free /studio/recompute refreshes the deterministic parts
    // and stamps recomputedAt, leaving the AI narrative flagged fromLastFullScan.
    studioScan: {
      fitScore: Number,
      recommendation: String,
      scoreBreakdown: {
        skillsScore: Number,
        experienceScore: Number,
        educationScore: Number,
        seniorityScore: Number,
        overallScore: Number,
      },
      matchedSkills: [{ name: String, importance: String }],
      missingSkills: [{ name: String, importance: String }],
      evidence: [{ quote: String, issue: String, fix: String }],
      sections: [
        {
          key: String,
          label: String,
          band: String, // 'ok' | 'warn' | 'bad'
          score: Number,
          quality: Number,
          relevance: Number,
          covered: Number,
          total: Number,
          missingKeywords: [String],
          // The verdict as a KEY plus its params — resolved client-side under
          // `ariaStudio.sectionNote.*` so a French user reads a French verdict.
          // Explicitly typed rather than Mixed: the shape is known and small, and
          // Mixed would forfeit change tracking on a subdoc we rewrite every recompute.
          noteKey: String,
          noteParams: {
            keywords: String,
          },
          // The LEGACY prose note. Deliberately kept: scans persisted before the
          // key/params split still carry a sentence here and no noteKey, and the client
          // falls back to it (studioFlow.sectionNote) so an old session doesn't render a
          // blank verdict in the window before its next free recompute.
          note: String,
        },
      ],
      // Where this CV STARTED against this job — captured on the FIRST scan and never
      // written again. Without it there is no honest "before → after": recompute
      // overwrites fitScore/sections in place, so by the time the user finishes, the
      // only surviving number is the current one. The finish card needs both.
      baseline: {
        fitScore: Number,
        sections: [{ key: String, band: String, score: Number }],
        capturedAt: Date,
      },
      jdHash: String,
      // Which version of sectionScan.service's RULES produced these sections
      // (SCAN_RULES_VERSION). jdHash tells us the JOB changed; this tells us the
      // SCORER changed — a persisted scan from an older ruleset isn't comparable to a
      // fresh one, and without the stamp there is no way to tell the two apart.
      rulesVersion: Number,
      scannedAt: Date,
      recomputedAt: Date,
      // True once a free recompute has refreshed the scores underneath an AI
      // narrative that was written for an earlier version of the CV.
      fromLastFullScan: { type: Boolean, default: false },
    },
    tailoredFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DraftCV",
    },
    tailoredForJob: {
      title: String,
      company: String,
      externalId: String,
      source: String,
    },
    // Per-entry generation state so the FIRST re-roll of an identical request is free.
    // { [sortId]: { hash: String, freeRerollAvailable: Boolean } }
    genState: { type: Object, default: {} },
    // A paid Studio generation remains recoverable until the user applies or discards it.
    // Only one generation card can be active in a Studio session at a time.
    studioPending: { type: mongoose.Schema.Types.Mixed, default: null },
    // Aria's per-section conversation, persisted ON the draft so it survives step
    // navigation, refresh, and other devices. { [stepId]: [{ who, text }] }. Session
    // flags (skip choice, always-allow, target ack) stay in the frontend coachState.
    coachChats: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Evidence gathered by the focused Aria interview, keyed by an entry's stable
    // _sortId. Kept outside experience/projects so a later narrow list autosave cannot
    // accidentally erase the server-verified interview record.
    coachEvidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    // The CROSS-HISTORY HUNT. When the employer wants something the CV hasn't shown, Aria
    // looks for it across the user's WHOLE history (other jobs, school, volunteering,
    // projects, training) before recording it as a gap — because people routinely forget
    // where they've done something.
    //
    // `askedIn` is what stops the hunt becoming nagging: a requirement is never re-asked
    // in a context it has already been asked about.
    requirementProbes: [
      {
        requirementId: String,
        name: String,
        status: { type: String, default: "open" }, // open|confirmed|declined|deferred
        // A rung of the honesty ladder — regular|basic|coursework|encountered|never.
        // Only the first three may put anything on the CV, and 'coursework' is labelled.
        level: { type: String, default: null },
        contextSortId: { type: String, default: null }, // WHERE they said they did it
        contextKind: { type: String, default: null }, // experience|project|education|training|volunteering|personal
        evidenceId: { type: String, default: null }, // links into coachEvidence
        askedIn: [String], // sortIds already asked — never re-ask in the same place
        askedAt: Date,
        answeredAt: Date,
      },
    ],
    // A clear "no", recorded once and honoured EVERYWHERE. This is the single mechanism
    // behind "she doesn't keep asking after you've said no" — read by the interview's
    // requirement ranking, the forced JD probe, the skills review groups, and every hunt
    // entry point. Deliberately separate from requirementProbes so a decline survives even
    // if the probe row is later rebuilt.
    skillDeclines: [
      {
        requirementId: String,
        name: String,
        level: String, // encountered|never
        source: String, // interview|skills_card|keyword_panel
        at: { type: Date, default: Date.now },
      },
    ],
    // The language this CV DOCUMENT is written in — distinct from the user's
    // interface language (User.interfaceLang). Aria can coach in English while
    // writing a French CV; that split is the point.
    // null = "not set" → falls back to the request language (req.lang). Existing
    // CVs are deliberately NOT backfilled, so they keep behaving exactly as before.
    outputLang: {
      type: String,
      enum: ["en", "fr"],
      default: null,
    },
    isComplete: {
      type: Boolean,
      default: false,
    },
    currentStep: {
      type: String,
      default: "target_job", // Store step ID so user can resume where they left off
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("DraftCV", draftCVSchema);
