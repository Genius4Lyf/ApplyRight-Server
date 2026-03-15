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

const corsOptions = {
  origin: process.env.FRONTEND_URL || "*", // STARTUP_CHECK: Configure this to your frontend domain in production
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
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
app.use("/api/resumes", resumeRoutes);
app.use("/api/ai", aiLimiter, aiRoutes); // Apply AI-specific rate limiter
app.use("/api/applications", applicationRoutes);
app.use("/api/analysis", require("./routes/analysis.routes"));
app.use("/api/cv", require("./routes/cv.routes"));
app.use("/api/pdf", require("./routes/pdf.routes"));
app.use("/api/billing", require("./routes/billing.routes"));
app.use("/api/feedback", require("./routes/feedback.routes"));
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
