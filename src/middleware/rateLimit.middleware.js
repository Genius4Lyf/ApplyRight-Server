// Default export, NOT the named one: the backend test suites mock this module as a bare
// jest.fn, so `{ rateLimit }` would be undefined under test. v8 attaches the named
// exports to the callable default, so this works in both.
const rateLimit = require("express-rate-limit");

// Normalises an IPv6 address to its subnet, so a client cannot rotate the last hextet to
// reset its own counter. Guarded because the test mock has no named exports; under that
// mock the limiter is a pass-through and keyGenerator never runs.
const ipKeyOf = require("express-rate-limit").ipKeyGenerator || ((req) => req.ip);

// CONVERSATION rate limiting — for Aria's chat and build-with routes.
//
// These used to sit behind app.js's aiLimiter (20/hour/IP), mounted across the WHOLE
// /api/coach router, and it was quietly breaking real builds. Three things were wrong:
//
//  1. THE NUMBER. buildAllowance's own comment in coach.controller says "a real CV build
//     uses ~40 turns". A cap of 20 requests an hour cannot finish a single build. Users
//     hit it mid-conversation and — because a 429 body carries no `code` — the client
//     fell through to its generic "couldn't reach Aria", which reads as a network fault
//     rather than a limit you can wait out.
//  2. THE KEY. Per-IP is wrong for a mobile-first audience. Behind a carrier NAT many
//     people share one address, so strangers ate each other's budget.
//  3. THE SCOPE. Mounting it on the router meant /model, /company-type and /no-target —
//     plain database writes that call no model at all — each burned an AI slot.
//
// THIS IS NOT THE SPEND CONTROL. Cost is metered per user, per turn, by the credit
// system: the daily free chat pool, then ARIA_CHAT_MESSAGE, plus the per-day build
// allowance. This limiter exists only so a looping or tampered client can't hammer the
// model, so it sits well above what a human conversation can produce and is keyed to the
// account producing it.
//
// MOUNT IT AFTER `protect`. req.user is what it keys on, and the auth middleware is what
// sets it — mounted on the router (before protect runs) every request would key on the
// IP fallback and the fix would be invisible.
const conversationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator is the library's own helper — it normalises IPv6 into a subnet so a
  // client can't trivially rotate the last hextet to reset its own counter.
  keyGenerator: (req, res) => (req.user?.id ? `user:${req.user.id}` : ipKeyOf(req, res)),
  // A CODE the client can branch on, so it can say "you're going too fast, wait a
  // moment" instead of "couldn't reach Aria".
  message: {
    code: "RATE_LIMITED",
    message: "That's a lot of messages in a short time. Give it a minute and try again.",
  },
});

module.exports = { conversationLimiter };
