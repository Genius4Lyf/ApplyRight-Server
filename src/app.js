const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const rateLimit = require("express-rate-limit");
const logger = require("./utils/logger");
const swaggerDocs = require("./config/swagger");
const { attachRateKey, keyOf, isAccountScoped } = require("./middleware/rateLimit.middleware");
const { requireFeature } = require("./middleware/featureFlag.middleware");

require("./config/env"); // This will validate env vars on startup

const app = express();

// Render (and most PaaS) put the app behind a reverse proxy that sets
// X-Forwarded-For. Without this, req.ip is the proxy's IP and
// express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. `1` = trust
// the single Render proxy hop (do NOT use `true`, which trusts any client-
// supplied XFF and lets attackers spoof their IP to dodge rate limits).
app.set("trust proxy", 1);

const allowedOrigins = [
  process.env.FRONTEND_URL, // Netlify production (set on Render)
  "https://localhost", // Capacitor Android default
  "capacitor://localhost", // Capacitor iOS default
  "http://localhost:5173", // Vite dev server
  "http://localhost:5174", // Vite dev server
  "http://localhost:4173", // Vite preview server
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server, curl, native HTTP
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// Middleware
app.use(helmet());
app.use(compression());

// Resolve WHO each request belongs to before any limiter counts it. See
// middleware/rateLimit.middleware for why: on a mobile-first, carrier-NAT audience an
// IP address is a crowd, not a person, and the limiters below were charging strangers
// for each other's usage.
app.use(attachRateKey);

// Global Rate Limiting.
//
// This is the blunt DoS backstop, not a product limit — the real controls are the
// per-route limiters (auth, verification, checkout, conversation, AI) and, for spend,
// the credit system. It should sit far above anything a human can produce and still
// stop a loop instantly.
//
// It did neither. 100 requests per 15 minutes, counted per IP, was BOTH too low and
// shared by strangers:
//
//   * Too low for one person. Aria is chatty by design — coach.controller's own
//     buildAllowance comment puts a real CV build at ~40 turns, and each turn is a
//     chat POST plus a debounced draft save. A focused quarter-hour in the builder
//     lands in the same order of magnitude as the cap.
//   * Shared by strangers. Behind a carrier NAT one address is thousands of people,
//     so the budget was drained by whoever got there first.
//
// Now it counts per ACCOUNT where a token identifies one, and keeps a separate, wider
// ceiling for the anonymous traffic that genuinely does share an address.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  keyGenerator: keyOf,
  // 600/15min for one signed-in account is ~40 requests a minute sustained: several
  // times the busiest real session, and still instant death for a runaway client.
  // The anonymous bucket is deliberately wider because it is shared: it covers the
  // landing page, login and signup for every person behind one address.
  limit: (req) => (isAccountScoped(req) ? 600 : 1200),
  standardHeaders: true,
  legacyHeaders: false,
  // AdMob SSV callbacks come from Google and can burst. Skip them; the
  // route itself is protected by ECDSA signature verification. The Flutterwave
  // webhook is likewise verified (verif-hash) and may retry, so skip it too.
  skip: (req) =>
    req.path === "/api/billing/admob-ssv" || req.path === "/api/billing/flutterwave-webhook",
  message: {
    message: "Too many requests, please try again after 15 minutes",
  },
});
app.use(globalLimiter);

// AI-Specific Rate Limiting.
//
// Same two corrections as the global limiter, for the same reason. This one guarded
// /api/ai — generate-skills, job-keywords, keyword-coverage, tighten-summary — at 20
// per hour PER IP, which on a shared carrier address was 20 AI actions per hour for
// everyone on that network between them.
//
// THIS IS NOT THE SPEND CONTROL, exactly as the conversation limiter says of itself:
// cost is metered per user, per action, by credits. This exists so a looping client
// can't hammer the model, so it belongs well above a human's pace and keyed to the
// account doing it.
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  keyGenerator: keyOf,
  limit: (req) => (isAccountScoped(req) ? 120 : 240),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "AI request limit reached for this hour. Please try again later.",
  },
});

// Checkout-Specific Rate Limiting. Each call mints a pending Payment row + hits
// Flutterwave; cap it so the endpoint can't be spammed to flood the Payment collection
// or the provider. A real buyer needs only a handful.
//
// Per ACCOUNT, not per IP. /checkout is behind `protect`, so a token is always
// present and always resolves — and this is the revenue path, the last place that
// should tell a paying customer to come back later because a stranger on the same
// carrier bought something first.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  keyGenerator: keyOf,
  limit: (req) => (isAccountScoped(req) ? 20 : 200),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many checkout attempts. Please wait a few minutes and try again.",
  },
});

// Logger configuration for HTTP requests
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

app.use(express.json()); // Body parser

// App language (X-App-Language) → req.lang, defaulting to "en".
app.use(require("./middleware/language.middleware"));

// Swagger Documentation
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Maintenance Mode Check
app.use(require("./middleware/maintenance.middleware"));

// Routes (Placeholders)
app.get("/", (req, res) => {
  res.send("ApplyRight API is running...");
});

// Import Routes
const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const jobRoutes = require("./routes/job.routes");
const resumeRoutes = require("./routes/resume.routes");
const aiRoutes = require("./routes/ai.routes");
const applicationRoutes = require("./routes/application.routes");

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
// NOT gated: /api/jobs is the CV builder's job-description extraction (the Target
// step), which is load-bearing for building a CV. Only /api/job-search — the parked
// listings feature — is behind the flag below.
app.use("/api/jobs", jobRoutes);
// Behind the admin toggle that has always existed and never did anything
// (features.enableJobSearch). These routes are PUBLIC and unauthenticated, and no page
// in the app links to the one surface that uses them — so until the feature is
// deliberately switched on, the only traffic they can receive is a crawler making this
// server scrape Jobberman on our IP for nobody.
app.use("/api/job-search", requireFeature("enableJobSearch"), require("./routes/jobSearch.routes"));
app.use("/api/resumes", resumeRoutes);
app.use("/api/ai", aiLimiter, aiRoutes); // Apply AI-specific rate limiter
app.use("/api/applications", applicationRoutes);
app.use("/api/analysis", require("./routes/analysis.routes"));
// Aria coach + Studio conversation. NOT globally AI-limited, and deliberately so: this
// router IS the build conversation, and aiLimiter (20/hour/IP) could not finish a single
// one — a real build runs ~40 turns. The router applies conversationLimiter itself, AFTER
// protect, so the budget is keyed to the ACCOUNT rather than to an IP shared by every
// user behind the same mobile carrier. Spend is metered per user by credits, not here.
app.use("/api/coach", require("./routes/coach.routes"));
// Aria Studio (agentic tailor) — builds a Role Brief. NOT globally AI-limited: most of
// this router (sessions/build-start/tailor-start/recompute) is document CRUD, not a
// model call. The router applies aiLimiter itself, only to the routes that call the
// model (/brief-preview, /scan).
app.use("/api/studio", require("./routes/studio.routes"));
app.use("/api/cv", require("./routes/cv.routes"));
app.use("/api/pdf", require("./routes/pdf.routes"));
app.use("/api/docx", require("./routes/docx.routes"));
app.use("/api/billing/checkout", checkoutLimiter);
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/feedback", require("./routes/feedback.routes"));
app.use("/api/ai-feedback", require("./routes/aiFeedback.routes"));
app.use("/api/interview-prep", require("./routes/interviewPrep.routes"));
app.use("/api/agent", require("./routes/agent.routes"));
app.use("/api/admin", require("./routes/admin.routes"));
app.use("/api/system", require("./routes/system.routes"));

// Global Error Handler
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({
    message: err.message || "Internal Server Error",
    stack: process.env.NODE_ENV === "production" ? null : err.stack,
  });
});

module.exports = app;
