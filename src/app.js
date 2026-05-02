const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const rateLimit = require("express-rate-limit");
const logger = require("./utils/logger");
const swaggerDocs = require("./config/swagger");

require("./config/env"); // This will validate env vars on startup

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL, // Netlify production (set on Render)
  "https://localhost", // Capacitor Android default
  "capacitor://localhost", // Capacitor iOS default
  "http://localhost:5173", // Vite dev server
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

// Global Rate Limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many requests from this IP, please try again after 15 minutes",
  },
});
app.use(globalLimiter);

// AI-Specific Rate Limiting (more restrictive due to costs)
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 AI requests per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "AI request limit reached for this hour. Please try again later.",
  },
});

// Logger configuration for HTTP requests
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

app.use(express.json()); // Body parser

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
app.use("/api/jobs", jobRoutes);
app.use("/api/job-search", require("./routes/jobSearch.routes"));
app.use("/api/resumes", resumeRoutes);
app.use("/api/ai", aiLimiter, aiRoutes); // Apply AI-specific rate limiter
app.use("/api/applications", applicationRoutes);
app.use("/api/analysis", require("./routes/analysis.routes"));
app.use("/api/cv", require("./routes/cv.routes"));
app.use("/api/pdf", require("./routes/pdf.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/feedback", require("./routes/feedback.routes"));
app.use("/api/ai-feedback", require("./routes/aiFeedback.routes"));
app.use("/api/interview-prep", require("./routes/interviewPrep.routes"));
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
