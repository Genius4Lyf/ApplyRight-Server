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
    // Immutable record of where the account was created (analytics / pricing
    // strategy / fraud). Must NEVER be overwritten after creation.
    signupCountry: {
      type: String,
      default: null,
      uppercase: true,
      trim: true,
    },
    // "Where are they now" — refreshed on each login. Neither this nor
    // signupCountry is the authority for what price to DISPLAY: display
    // pricing always uses live request geo, so pricing follows the person,
    // not their history.
    lastSeenCountry: {
      type: String,
      default: null,
      uppercase: true,
      trim: true,
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
    // that they buy ₦1,000 single-download passes or subscribe (paid = unlimited).
    downloads: {
      freeDownloadUsed: { type: Boolean, default: false },
      passRemaining: { type: Number, default: 0 },
    },
    // RETIRED — kept for the data only. This was the one-time taste of the real
    // (JD-keyword-targeted) suggestions in the two-column work-history picker, which
    // the Ask Aria build-with replaced entirely (/coach/generate-bullets). Nothing
    // reads or writes it any more; it stays declared so existing users' flags are not
    // silently dropped from their documents on the next save.
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
    // Aria free BUILD-WITH daily budget (resets by calendar date, same shape as
    // ariaChat). Build-with is never charged — this is an anti-abuse ceiling only.
    ariaBuild: {
      date: String, // 'YYYY-MM-DD' of the current window
      count: { type: Number, default: 0 },
      // Lifetime cap-hit telemetry (never reset) — powers the admin guard view.
      // A real user hits this 0-1 times ever; a looping client racks up dozens.
      capHits: { type: Number, default: 0 },
      lastCapHitAt: { type: Date, default: null },
    },
    // Free daily cover letter (free tier only). Resets by calendar date, same
    // shape as ariaChat. Paid users don't draw from this — they pay credits.
    coverLetterFree: {
      date: String, // 'YYYY-MM-DD' of the current window
      count: { type: Number, default: 0 },
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
    // Support-grantable override: when true, this user passes straight through
    // maintenance mode instead of getting the 503 (see maintenance.middleware.js).
    // For running an app-wide maintenance window while still letting a hand-picked
    // list of people in — e.g. an awareness-campaign cohort invited in ahead of a
    // public launch. Admin-set only; a user cannot grant this to themselves.
    maintenanceAccess: {
      type: Boolean,
      default: false,
    },
    // Pre-launch campaign markers. TIMESTAMPS, not booleans, and stored rather than
    // derived: "did this account get the bonus?" cannot be inferred from
    // createdAt < launch.date, because moving the launch date would silently re-grant
    // credits on the next run. Storing the moment also makes both operations RESUMABLE
    // — a crash halfway leaves the finished half marked and a re-run picks up the rest.
    // When this account proved it owned its email address. A TIMESTAMP rather than a
    // boolean, because null has to mean "predates the requirement" and not
    // "unverified" — every account created since verification shipped proved it
    // BEFORE the account existed, so there is no such thing as an unverified account
    // and nothing gates on this. That is what keeps the existing accounts logged in.
    emailVerifiedAt: { type: Date, default: null },
    launchBonusGrantedAt: { type: Date, default: null },
    // Two fields, not one, and that is the point. `ClaimedAt` is set BEFORE the send
    // (filtered on null, which is what makes a double-send impossible); `SentAt` is set
    // AFTER Resend accepts. The pair {claimed, not sent} is exactly the crash window and
    // is precisely requeueable. Collapse them into one field and you must choose between
    // "may double-send" and "may never send".
    launchEmailClaimedAt: { type: Date, default: null },
    launchEmailSentAt: { type: Date, default: null },
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
