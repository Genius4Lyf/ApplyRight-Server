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
// Bound the per-turn input cost of a multi-turn voice session. Without this, every
// turn re-sends the whole growing audio history as input; prompt caching discounts
// the matching prefix but the bill still creeps up. A retention_ratio < 1.0 prunes
// older turns more aggressively (keeping cache headroom), and post_instructions caps
// the per-response input tokens (excluding the cached instruction block). Both are
// env-tunable; defaults are conservative for a ~6-minute mock interview.
const buildTruncation = () => {
  const ratio = Number(process.env.REALTIME_RETENTION_RATIO);
  const postInstr = Number(process.env.REALTIME_POST_INSTRUCTION_TOKENS);
  return {
    type: "retention_ratio",
    retention_ratio: Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.8,
    token_limits: {
      post_instructions:
        Number.isFinite(postInstr) && postInstr > 0 ? Math.round(postInstr) : 4000,
    },
  };
};

// Tool a panel interviewer calls the moment they've finished their portion, so
// the CLIENT can hand the floor to the next interviewer's (already pre-connected)
// voice seamlessly — instead of cutting on a stopwatch. Only attached for
// non-final panel seats.
const HANDOFF_TOOL = {
  type: "function",
  name: "hand_off_to_next",
  description:
    "Call this the MOMENT you have finished your portion of the panel interview AND have just spoken your brief, natural hand-off line to the candidate (naming the next interviewer). This passes the floor to the next interviewer. Do NOT call it until you are genuinely done with your own questions, and never mid-way through the candidate's answer.",
  parameters: { type: "object", properties: {}, required: [] },
};

// Single-voice panel: the model plays all interviewers in one continuous session.
// It calls this whenever a DIFFERENT panelist takes the floor so the candidate's
// screen highlights who is currently talking. UI-only — the conversation never
// blocks on it.
const SET_SPEAKER_TOOL = {
  type: "function",
  name: "set_active_speaker",
  description:
    "Call this whenever the focus of the interview moves to a different panel member — i.e. when you (the HR host) start relaying a question on a colleague's behalf, pass that colleague's FIRST NAME; when you return to your own HR questions, pass the HR host's first name. This highlights who the current question belongs to on the candidate's screen. Call it right before you ask that question.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "First name of the panel member whose question is now being asked",
      },
    },
    required: ["name"],
  },
};

const buildSessionConfig = (
  instructions,
  model,
  voice,
  { enableHandoff = false, enableSpeakerTool = false } = {}
) => {
  // Optional voice playback speed (e.g. 1.1 for a snappier, less-draggy delivery).
  // Only included when REALTIME_SPEED is set, so we never risk a 400 by default.
  const output = { voice };
  const speed = Number(process.env.REALTIME_SPEED);
  if (Number.isFinite(speed) && speed > 0) output.speed = speed;

  const session = {
    type: "realtime",
    model,
    instructions,
    truncation: buildTruncation(),
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
  };
  const tools = [];
  if (enableHandoff) tools.push(HANDOFF_TOOL);
  if (enableSpeakerTool) tools.push(SET_SPEAKER_TOOL);
  if (tools.length) {
    session.tools = tools;
    session.tool_choice = "auto";
  }

  return { session };
};

// Legacy (flat) shape — only tried if the nested shape 400s, to absorb API drift.
// Keeps transcription so end-of-interview grading still works on the fallback path.
const buildLegacySessionConfig = (
  instructions,
  model,
  voice,
  { enableHandoff = false, enableSpeakerTool = false } = {}
) => {
  const cfg = {
    model,
    voice,
    instructions,
    modalities: ["audio", "text"],
    input_audio_transcription: { model: "whisper-1" },
    turn_detection: { type: "server_vad" },
  };
  const tools = [];
  if (enableHandoff) tools.push(HANDOFF_TOOL);
  if (enableSpeakerTool) tools.push(SET_SPEAKER_TOOL);
  if (tools.length) {
    cfg.tools = tools;
    cfg.tool_choice = "auto";
  }
  return cfg;
};

/**
 * Mint an ephemeral client secret for a single realtime session.
 * @returns {{ clientSecret, expiresAt, model, voice, maxSessionSec }}
 * @throws {RealtimeUnavailableError} when no key is set or OpenAI errors.
 */
// OpenAI realtime voices we let users pick from. Keep in sync with the frontend.
const ALLOWED_VOICES = ["marin", "cedar", "alloy", "sage", "verse", "shimmer", "ash"];

const mintRealtimeSession = async ({
  instructions,
  voice: requestedVoice,
  model: modelOverride,
  maxSessionSec: maxSessionSecOverride,
  enableHandoff = false,
  enableSpeakerTool = false,
}) => {
  // Dedicated realtime key so live-interview spend is tracked on its own OpenAI
  // account. Falls back to the shared key if a separate one isn't configured.
  const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new RealtimeUnavailableError("OPENAI_REALTIME_API_KEY / OPENAI_API_KEY not configured");

  // Caller (the tier-aware controller) may override the model per user. Default to
  // the mini speech2speech model: ~3-4x cheaper than full gpt-realtime with
  // negligible quality loss for a practice mock. Premium (pro) tier passes the
  // full "gpt-realtime" for its sharper interviewer.
  const model = modelOverride || process.env.REALTIME_MODEL || "gpt-realtime-mini";
  const voice = ALLOWED_VOICES.includes(requestedVoice)
    ? requestedVoice
    : process.env.REALTIME_VOICE || "marin";
  // Caller passes the per-user reserved seconds; fall back to the env cap.
  const maxSessionSec =
    Number(maxSessionSecOverride) > 0
      ? Math.round(Number(maxSessionSecOverride))
      : Number(process.env.REALTIME_MAX_SESSION_SEC) || 360;

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  const post = (body) => axios.post(CLIENT_SECRETS_URL, body, { headers, timeout: 15000 });

  let data;
  try {
    const res = await post(
      buildSessionConfig(instructions, model, voice, { enableHandoff, enableSpeakerTool })
    );
    data = res.data;
  } catch (err) {
    // One-shot fallback to the legacy flat shape on a 400 (schema drift).
    if (err.response?.status === 400) {
      try {
        const res = await post(
          buildLegacySessionConfig(instructions, model, voice, { enableHandoff, enableSpeakerTool })
        );
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
