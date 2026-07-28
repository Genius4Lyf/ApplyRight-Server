const mongoose = require("mongoose");
const { validateRegistrationEmail } = require("../utils/emailValidation");

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, "Please add an email"],
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        validator: (v) => validateRegistrationEmail(v).ok,
        message: (props) => validateRegistrationEmail(props.value).message,
      },
    },
    password: {
      type: String,
      required: true,
    },
    plan: {
      type: String,
      enum: ["free", "paid"],
      default: "free",
    },
    // Subscription tier for premium features (e.g. Interview Mode variants).
    // Separate from `plan` (the lifetime template unlock). Admin-set during
    // testing; a payment provider can set it later. See requireTier middleware.
    tier: {
      type: String,
      enum: ["free", "plus", "pro"],
      default: "free",
    },
    // The user's DEFAULT model for Aria's chat / tailoring (config/catalog DEFAULT_MODELS
    // id). A per-session choice (DraftCV.studioModelId) overrides it; the resolver picks
    // session → this → DEFAULT_MODEL. Kept as a plain id (no enum) so the admin can add
    // models without a migration. Default null → the resolver falls back to DEFAULT_MODEL.
    aiModelId: {
      type: String,
      default: null,
    },
    // Time-boxed entitlement from a one-time Flutterwave purchase. `tier` (above)
    // is kept in sync on grant so requireTier keeps working; THIS subdoc is the
    // source of truth for expiry (effective tier is computed lazily on read —
    // see subscription.service.getEffectiveTier). No auto-renew: when expiresAt
    // passes, the user is treated as free until they buy again.
    subscription: {
      planId: { type: String, default: null }, // catalog id, e.g. "monthly_premium"
      tier: { type: String, enum: ["free", "plus", "pro"], default: "free" },
      status: { type: String, enum: ["active", "expired", "none"], default: "none" },
      source: { type: String, enum: ["flutterwave", "admin", "none"], default: "none" },
      currentPeriodStart: { type: Date, default: null },
      expiresAt: { type: Date, default: null }, // null => no active subscription
      // Per-tier credit allowance for text-AI/CV/prep. Set on each grant (REPLACE,
      // no roll-over); spent BEFORE the persistent `credits` wallet; ignored once
      // the subscription expires. The wallet (free + ad + referral + top-up) persists.
      creditsRemaining: { type: Number, default: 0 },
    },
    // Live (voice) interview minute balance. Minutes expire each period (no
    // rollover): a new subscription REPLACES secondsRemaining; top-ups $inc it.
    liveInterview: {
      secondsRemaining: { type: Number, default: 0 },
      periodExpiresAt: { type: Date, default: null },
      // Free tier's one-time taste (lifetime, never reset), capped at FREE_TASTE_SEC.
      freeTasteUsedSec: { type: Number, default: 0 },
      // In-flight reservation while a session is live (reserve-then-reconcile).
      // `mode` records which balance was debited so reconcile refunds the right one.
      activeReservation: {
        reservationId: { type: String, default: null },
        reservedSec: { type: Number, default: 0 },
        startedAt: { type: Date, default: null },
        mode: { type: String, enum: ["free", "paid", null], default: null },
        // Multi-voice panel (Premium) mints one realtime session PER seat under
        // this single reservation. Counts mints so a client can't spin up
        // unbounded paid OpenAI sessions (cost guard); see mintRealtimeSegment.
        segmentsMinted: { type: Number, default: 0 },
      },
    },
    // CV PDF downloads. Free users get one clean download (lifetime taste); after
    // that they buy ₦500 single-download passes or subscribe (paid = unlimited).
    downloads: {
      freeDownloadUsed: { type: Boolean, default: false },
      passRemaining: { type: Number, default: 0 },
    },
    // ApplyRight ATS suggestions. Free users get ONE lifetime taste of the real
    // (JD-keyword-targeted) suggestions on a single work-history role; afterwards
    // the ATS column is a blurred upsell teaser. Claimed atomically on generate.
    atsSuggestions: {
      freeTasteUsed: { type: Boolean, default: false },
    },
    // CV Builder ATS Coach. The "Deep Scan" (Job Match + Career Match + recruiter
    // red-flags) is paid; free users get ONE lifetime taste, claimed atomically on
    // run (mirrors atsSuggestions). CV Health stays free and is computed client-side.
    coach: {
      deepScanTasteUsed: { type: Boolean, default: false },
      // Live AI coach (conversational guidance). Free users get a daily quota
      // (COACH_GUIDE_FREE_DAILY); paid = unlimited. `date` is a UTC YYYY-MM-DD
      // string; `count` resets when the date rolls over.
      aiGuide: {
        date: { type: String, default: "" },
        count: { type: Number, default: 0 },
      },
    },
    // "agent" = a CV-writing agent (builds CVs for paying clients). Agents get a
    // CV-only dashboard (no interview/job-search/credits UI); see Client model and
    // agent.routes. Set self-serve at signup via accountType: "agent".
    role: {
      type: String,
      enum: ["user", "admin", "agent"],
      default: "user",
    },
    credits: {
      type: Number,
      default: 20, // Free starting credits
    },
    // App language. Drives both the UI strings and the language every AI response
    // comes back in (threaded to ai.service via req.lang → meta.lang → langDirective).
    interfaceLang: {
      type: String,
      enum: ["en", "fr"],
      default: "en",
    },
    adStreak: {
      current: { type: Number, default: 0 },
      longest: { type: Number, default: 0 },
      lastWatchDate: { type: Date, default: null },
    },
    // Per-watch anti-abuse counters. UTC midnight resets todayCount.
    adWatch: {
      lastAt: { type: Date, default: null },
      todayCount: { type: Number, default: 0 },
      todayDate: { type: Date, default: null },
    },
    // Aria free-chat daily allowance (resets by calendar date). 10/day free, then credits.
    ariaChat: {
      date: String, // 'YYYY-MM-DD' of the current window
      count: { type: Number, default: 0 }, // messages used in that window
    },
    hasEverPurchased: {
      type: Boolean,
      default: false,
    },
    // Login activity (set on each successful login). lastLoginAt is for quick
    // per-user display; DAU/WAU/MAU time-series come from the LoginEvent model.
    lastLoginAt: {
      type: Date,
      default: null,
    },
    loginCount: {
      type: Number,
      default: 0,
    },
    // Support-grantable override: when true, ALL interview-loop interviewers are
    // unlocked for this user (bypasses the per-round 65% gate). Set by an admin
    // when a user reaches out to support. Does not affect minutes/credits.
    unlockAllInterviewers: {
      type: Boolean,
      default: false,
    },
    unlockedTemplates: [String],
    referralCode: {
      type: String,
      unique: true,
      sparse: true, // Allows null/undefined values to not violate uniqueness (though we generate for all)
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    referralCount: {
      type: Number,
      default: 0,
    },
    firstName: {
      type: String,
      default: "",
    },
    lastName: {
      type: String,
      default: "",
    },
    otherName: {
      type: String,
      default: "",
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    portfolioUrl: {
      type: String,
      default: "",
    },
    linkedinUrl: {
      type: String,
      default: "",
    },
    currentJobTitle: {
      type: String,
      default: "",
    },
    currentStatus: {
      type: String,
      enum: ["student", "graduate", "professional", "other"],
    },
    education: {
      university: String,
      discipline: String,
      graduationYear: String,
    },
    careerGoals: [
      {
        type: String,
      },
    ],
    skills: [
      {
        type: String,
      },
    ],
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },
    settings: {
      autoGenerateAnalysis: {
        type: Boolean,
        default: false,
      },
      showOnboardingTutorials: {
        type: Boolean,
        default: true,
      },
      hideSkillsAiPrompt: {
        type: Boolean,
        default: false,
      },
      // Notification preferences (Account hub → Notifications tab). Stored
      // user intent; consulted by the relevant send sites as they get wired up.
      notifications: {
        productUpdates: { type: Boolean, default: true },
        interviewReminders: { type: Boolean, default: true },
        applicationNudges: { type: Boolean, default: true },
        marketingEmails: { type: Boolean, default: false },
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("User", userSchema);
