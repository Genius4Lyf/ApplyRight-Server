// How someone wants their Aria call to go. One source of truth for the User schema enums,
// the profile-update whitelist, and the call itself, so a value that is not listed here can
// never reach a prompt or OpenAI.
//
// Three independent choices, deliberately NOT bundled into presets: depth and style are
// separate things — an experienced professional may well want Direct AND Thorough.
//
//   depth  — WHAT Aria asks. `thorough` works through every activity and digs for the small
//            things people don't count as achievements (trusted with the keys, trained a new
//            starter). `quick` covers the main activities and their results and wraps sooner.
//   style  — HOW she sounds. It never changes what she may write or what the bullets may
//            claim: the honesty rules, the recap-and-confirm before ending, and the job's
//            requirements are the same in every style.
//   voice/pace — who is speaking and how fast.
//
// Cost, for anyone reading prices: Aria SPEAKING is billed at twice the rate of Aria
// LISTENING (gpt-realtime-2.1-mini: $20 vs $10 per 1M audio tokens). Coach talks the most,
// Direct the least, and Quick ends sooner — so the cheapest call is Quick + Direct.

const DEPTHS = ["thorough", "quick"];
const STYLES = ["friendly", "direct", "coach"];

// Two voices, not the seven the Realtime API offers. marin and cedar are the two OpenAI
// introduced as its most natural for gpt-realtime, and without a way to preview a voice, a
// list of seven unfamiliar names is not a real choice.
const VOICES = ["marin", "cedar"];

const PACES = ["normal", "slower"];

// `normal` sends no speed at all, so the environment's REALTIME_SPEED (if any) still applies.
// `slower` is gentle on purpose: much below ~0.9 starts to sound unnatural rather than clear,
// and the point is people following in a second language, not dictation.
const PACE_SPEED = { normal: undefined, slower: 0.9 };

const DEFAULT_CALL_SETTINGS = Object.freeze({
  depth: "thorough",
  style: "friendly",
  voice: "marin",
  pace: "normal",
});

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * Anything in, only listed values out. Unknown or missing fields fall back to the defaults.
 * @param {object} raw
 * @returns {{depth:string, style:string, voice:string, pace:string}}
 */
const normalizeCallSettings = (raw = {}) => {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    depth: pick(src.depth, DEPTHS, DEFAULT_CALL_SETTINGS.depth),
    style: pick(src.style, STYLES, DEFAULT_CALL_SETTINGS.style),
    voice: pick(src.voice, VOICES, DEFAULT_CALL_SETTINGS.voice),
    pace: pick(src.pace, PACES, DEFAULT_CALL_SETTINGS.pace),
  };
};

module.exports = {
  DEPTHS,
  STYLES,
  VOICES,
  PACES,
  PACE_SPEED,
  DEFAULT_CALL_SETTINGS,
  normalizeCallSettings,
};
