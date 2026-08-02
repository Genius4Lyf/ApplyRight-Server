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
  OPENAI_API_KEY: z.string().optional(), // general AI features (CV, cover letters, analysis, OpenAI TTS)
  OPENAI_REALTIME_API_KEY: z.string().optional(), // dedicated key for the live interview ONLY; does NOT fall back to OPENAI_API_KEY (live voice 503s if unset)
  ANTHROPIC_API_KEY: z.string().optional(), // Claude models selected through Aria's per-CV model picker
  GEMINI_API_KEY: z.string().optional(),
  AI_PROVIDER: z.enum(["openai", "anthropic", "gemini"]).default("gemini"),
  // Realtime (live voice) interview — OpenAI Realtime API over WebRTC.
  REALTIME_MODEL: z.string().default("gpt-realtime-2.1-mini"), // mini = ~3-4x cheaper; use "gpt-realtime-2.1" for premium tier
  REALTIME_VOICE: z.string().default("marin"), // realtime voices: marin / cedar / alloy
  REALTIME_MAX_SESSION_SEC: z.coerce.number().int().positive().default(360), // cost guardrail
  // Turn-taking sensitivity. "low" = wait longest before deciding the candidate has
  // finished (interrupting an interviewee is worse than a beat of silence). Set to
  // the literal "server_vad" to force the silence-based fallback.
  REALTIME_VAD_EAGERNESS: z.string().default("low"), // low | medium | high | auto | server_vad
  REALTIME_VAD_SILENCE_MS: z.coerce.number().int().positive().default(1800), // server_vad fallback only
  REALTIME_GRACE_SEC: z.coerce.number().int().nonnegative().default(90), // wind-down window after time-up for the closing ("any questions for me?")
  REALTIME_SPEED: z.coerce.number().positive().optional(), // optional voice speed, e.g. 1.1 (snappier)
  REALTIME_RETENTION_RATIO: z.coerce.number().positive().max(1).default(0.8), // <1.0 prunes old turns to cap per-turn input cost
  REALTIME_POST_INSTRUCTION_TOKENS: z.coerce.number().int().positive().default(4000), // per-response input cap (excl. cached instructions)
  ADMOB_SSV_KEYS_URL: z
    .string()
    .url()
    .default("https://www.gstatic.com/admob/reward/verifier-keys.json"),
  ADMOB_REWARD_AMOUNT_ANDROID: z.coerce.number().int().positive().default(10),
  ADMOB_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
  ADMOB_DAILY_CAP: z.coerce.number().int().positive().default(10),
  // Free build-with anti-abuse ceiling (see coach.controller.js buildAllowance). Tunable
  // from Render without a deploy if a real build ever needs more than 60 turns/day.
  ARIA_BUILD_DAILY_CAP: z.coerce.number().int().positive().default(60),
  ADMOB_REWARDED_UNIT_ID_ALLOWLIST: z.string().optional(),
  // Flutterwave one-time payments. Optional so the app still boots without them
  // (checkout/webhook will 503 until configured), mirroring the AI-key pattern.
  FLUTTERWAVE_PUBLIC_KEY: z.string().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLW_SECRET_HASH: z.string().optional(), // shared secret echoed in the webhook's verif-hash header
  FLUTTERWAVE_BASE_URL: z.string().url().default("https://api.flutterwave.com/v3"),
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
