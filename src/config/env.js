const { z } = require("zod");
const dotenv = require("dotenv");
const logger = require("../utils/logger");

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.string().default("5000"),
  MONGO_URI: z.string().url("MONGO_URI must be a valid URL"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_EXPIRE: z.string().default("30d"),
  FRONTEND_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  AI_PROVIDER: z.enum(["openai", "gemini"]).default("gemini"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  logger.error("❌ Invalid environment variables:");
  result.error.issues.forEach((issue) => {
    logger.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

module.exports = result.data;
