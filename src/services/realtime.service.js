// Realtime (live voice) interview — OpenAI Realtime API over WebRTC.
// This service ONLY mints a short-lived ephemeral client secret. The browser
// then performs the WebRTC SDP handshake DIRECTLY with OpenAI using that secret,
// so audio never flows through our backend (no WebSocket server needed).
//
// SECURITY: never log the ephemeral secret, the Authorization header, or the raw
// OpenAI response — they grant access to a realtime session.
const axios = require("axios");

class RealtimeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RealtimeUnavailableError";
    this.code = "REALTIME_UNAVAILABLE";
  }
}

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

// Current (nested) session-config shape. The candidate's CV/job grounding rides
// in `instructions`; server-side VAD lets the model take turns naturally.
const buildSessionConfig = (instructions, model, voice) => {
  // Optional voice playback speed (e.g. 1.1 for a snappier, less-draggy delivery).
  // Only included when REALTIME_SPEED is set, so we never risk a 400 by default.
  const output = { voice };
  const speed = Number(process.env.REALTIME_SPEED);
  if (Number.isFinite(speed) && speed > 0) output.speed = speed;

  return {
    session: {
      type: "realtime",
      model,
      instructions,
      audio: {
        input: {
          // Transcribe the candidate's speech so the client can collect a transcript
          // for end-of-interview AI grading (audio never reaches our backend).
          transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
        },
        output,
      },
    },
  };
};

// Legacy (flat) shape — only tried if the nested shape 400s, to absorb API drift.
// Keeps transcription so end-of-interview grading still works on the fallback path.
const buildLegacySessionConfig = (instructions, model, voice) => ({
  model,
  voice,
  instructions,
  modalities: ["audio", "text"],
  input_audio_transcription: { model: "whisper-1" },
  turn_detection: { type: "server_vad" },
});

/**
 * Mint an ephemeral client secret for a single realtime session.
 * @returns {{ clientSecret, expiresAt, model, voice, maxSessionSec }}
 * @throws {RealtimeUnavailableError} when no key is set or OpenAI errors.
 */
// OpenAI realtime voices we let users pick from. Keep in sync with the frontend.
const ALLOWED_VOICES = ["marin", "cedar", "alloy", "sage", "verse", "shimmer", "ash"];

const mintRealtimeSession = async ({ instructions, voice: requestedVoice }) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new RealtimeUnavailableError("OPENAI_API_KEY not configured");

  const model = process.env.REALTIME_MODEL || "gpt-realtime";
  const voice = ALLOWED_VOICES.includes(requestedVoice)
    ? requestedVoice
    : process.env.REALTIME_VOICE || "marin";
  const maxSessionSec = Number(process.env.REALTIME_MAX_SESSION_SEC) || 360;

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const post = (body) => axios.post(CLIENT_SECRETS_URL, body, { headers, timeout: 15000 });

  let data;
  try {
    const res = await post(buildSessionConfig(instructions, model, voice));
    data = res.data;
  } catch (err) {
    // One-shot fallback to the legacy flat shape on a 400 (schema drift).
    if (err.response?.status === 400) {
      try {
        const res = await post(buildLegacySessionConfig(instructions, model, voice));
        data = res.data;
      } catch {
        throw new RealtimeUnavailableError("Failed to create realtime session");
      }
    } else {
      // Do NOT surface the OpenAI error body — it can echo request data.
      throw new RealtimeUnavailableError("Failed to create realtime session");
    }
  }

  const clientSecret = data?.value || data?.client_secret?.value;
  const expiresAt =
    data?.expires_at || data?.client_secret?.expires_at || Math.floor(Date.now() / 1000) + 60;

  if (!clientSecret) throw new RealtimeUnavailableError("No client secret returned");

  // Safe to log: no secret material.
  console.log(`[Realtime] session minted (model=${model}, voice=${voice})`);

  return { clientSecret, expiresAt, model, voice, maxSessionSec };
};

module.exports = { mintRealtimeSession, RealtimeUnavailableError, ALLOWED_VOICES };
