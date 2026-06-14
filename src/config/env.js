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
  // Realtime (live voice) interview — OpenAI Realtime API over WebRTC.
  REALTIME_MODEL: z.string().default("gpt-realtime"),
  REALTIME_VOICE: z.string().default("marin"), // realtime voices: marin / cedar / alloy
  REALTIME_MAX_SESSION_SEC: z.coerce.number().int().positive().default(360), // cost guardrail
  REALTIME_SPEED: z.coerce.number().positive().optional(), // optional voice speed, e.g. 1.1 (snappier)
  ADMOB_SSV_KEYS_URL: z
    .string()
    .url()
    .default("https://www.gstatic.com/admob/reward/verifier-keys.json"),
  ADMOB_REWARD_AMOUNT_ANDROID: z.coerce.number().int().positive().default(10),
  ADMOB_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
  ADMOB_DAILY_CAP: z.coerce.number().int().positive().default(10),
  ADMOB_REWARDED_UNIT_ID_ALLOWLIST: z.string().optional(),
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
