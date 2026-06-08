// Text-to-speech for Interview Mode. Provider-pluggable: ElevenLabs (default,
// most human-like) or OpenAI TTS (cheaper, still natural), chosen via TTS_PROVIDER.
// The frontend falls back to the browser's built-in voice when this is unconfigured.
const axios = require("axios");
const OpenAI = require("openai");

class TTSUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = "TTS_UNAVAILABLE";
  }
}

const MAX_CHARS = 1200; // bound cost / latency per request

// The active provider is admin-switchable (SystemSettings.tts.provider), falling
// back to the TTS_PROVIDER env var, then ElevenLabs. DB read is best-effort so a
// settings hiccup never hard-fails synthesis.
const resolveProvider = async () => {
  try {
    const SettingsService = require("./settings.service");
    const p = await SettingsService.get("tts.provider");
    if (p) return String(p).toLowerCase();
  } catch {
    /* fall through to env/default */
  }
  return (process.env.TTS_PROVIDER || "elevenlabs").toLowerCase();
};

const synthesizeElevenLabs = async (text) => {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new TTSUnavailableError("ELEVENLABS_API_KEY not configured");
  // Default voice: "Rachel" (a stock ElevenLabs voice). Override per deployment.
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: modelId,
      voice_settings: { stability: 0.4, similarity_boost: 0.75 },
    },
    {
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      responseType: "arraybuffer",
      timeout: 30000,
    }
  );
  return Buffer.from(res.data);
};

let openaiClient = null;
const synthesizeOpenAI = async (text) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new TTSUnavailableError("OPENAI_API_KEY not configured");
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: key });
  const resp = await openaiClient.audio.speech.create({
    model: process.env.OPENAI_TTS_MODEL || "tts-1",
    voice: process.env.OPENAI_TTS_VOICE || "onyx",
    input: text,
  });
  return Buffer.from(await resp.arrayBuffer());
};

// True when premium voice is enabled and the active provider has a usable key.
const isConfigured = async () => {
  const provider = await resolveProvider();
  if (provider === "off") return false;
  if (provider === "openai") return !!process.env.OPENAI_API_KEY;
  return !!process.env.ELEVENLABS_API_KEY;
};

// Synthesize `text` to an mp3 Buffer using the active provider.
const synthesize = async (text) => {
  const clean = (typeof text === "string" ? text : "").trim().slice(0, MAX_CHARS);
  if (!clean) throw new TTSUnavailableError("No text to synthesize");
  const provider = await resolveProvider();
  if (provider === "off") throw new TTSUnavailableError("Premium voice is disabled");
  if (provider === "openai") return synthesizeOpenAI(clean);
  return synthesizeElevenLabs(clean);
};

module.exports = { synthesize, isConfigured, TTSUnavailableError };
