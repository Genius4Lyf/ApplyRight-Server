// Default export, NOT the named one: the backend test suites mock this module as a bare
// jest.fn, so `{ rateLimit }` would be undefined under test. v8 attaches the named
// exports to the callable default, so this works in both.
const rateLimit = require("express-rate-limit");

// Normalises an IPv6 address to its subnet, so a client cannot rotate the last hextet
// to reset its own counter.
//
// IT TAKES THE ADDRESS, NOT THE REQUEST. express-rate-limit v8 changed the signature to
// `ipKeyGenerator(ip: string)`, and calling it `(req, res)` does not throw — `isIPv6()`
// simply says no and it hands the REQUEST OBJECT back as the key. A fresh object every
// time is a fresh Map entry every time, so the limiter counts to one, forever, and
// limits nothing. It fails open and silently: no error, no log, just a backstop that
// is not there. Every IP fallback in this codebase was calling it the old way.
//
// The `|| req.ip` guard is for the suites that mock express-rate-limit as a bare
// jest.fn with no named exports; under that mock the limiter is a pass-through and
// keyGenerator never runs anyway.
const { ipKeyGenerator } = require("express-rate-limit");
const ipKeyOf = (req) => (ipKeyGenerator ? ipKeyGenerator(req.ip || "") : req.ip);

const jwt = require("jsonwebtoken");

// --- WHO IS THIS REQUEST FOR? -------------------------------------------------
//
// Every limiter in this app counted per IP, and on a Nigerian mobile network an IP is
// not a person. Carrier-grade NAT puts thousands of subscribers behind a handful of
// public addresses, so "20 per IP per hour" really means "20 for everyone on this
// carrier this hour", and the twenty-first stranger is told to slow down for something
// they have not done. That is the same defect that was blocking signups.
//
// The fix is to count against the thing actually being protected. Where a request
// carries a token, that thing is the ACCOUNT: one person, one budget, wherever they
// happen to connect from.
//
// Decoding the token here repeats a few microseconds of what `protect` does later, and
// that is the point: the global and /api/ai limiters are mounted at the APP level, so
// they run before any route's `protect` and would otherwise never see a user. This is
// the full signature check, so a forged or expired token buys nothing - it fails here
// exactly as it will fail in `protect`, and falls back to the address.
const accountIdOf = (req) => {
  if (req.user?.id) return String(req.user.id);
  const header = req.headers?.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    return decoded?.id ? String(decoded.id) : null;
  } catch {
    // Garbage is not an identity. Treating it as one would let a client mint a fresh
    // budget every time it minted a fresh fake token.
    return null;
  }
};

// Mounted once, early, in app.js. Resolving the key here instead of inside each
// limiter means the token is verified once per request however many limiters a route
// passes through, and every limiter agrees on who the caller is.
const attachRateKey = (req, res, next) => {
  const id = accountIdOf(req);
  req.rateKey = id ? { key: `user:${id}`, scope: "account" } : { key: ipKeyOf(req), scope: "ip" };
  next();
};

// The keyGenerator every limiter should use. It recomputes the key when attachRateKey
// has not run - which is how the test suites build their stub apps, and how a router
// mounted on its own behaves - so a missing mount degrades to correct-but-slower rather
// than to everyone silently sharing one bucket.
const keyOf = (req) => {
  if (req.rateKey?.key) return req.rateKey.key;
  const id = accountIdOf(req);
  return id ? `user:${id}` : ipKeyOf(req);
};

// True when this request is counted against one person rather than a shared address.
// The two deserve different ceilings: an account budget belongs to a single human and
// can be tight, while an address budget is shared by an unknown crowd and has to leave
// room for all of them.
const isAccountScoped = (req) =>
  req.rateKey ? req.rateKey.scope === "account" : Boolean(accountIdOf(req));

// Anonymous endpoints have no account to count against - but they do name the thing
// being abused. A signup, a password reset and a verification code all target one
// EMAIL ADDRESS, and that address is in the body. Keying on it puts the budget on the
// inbox being mailed rather than on every stranger sharing a carrier.
const emailKeyOf = (prefix) => (req) => {
  const email = String(req.body?.email || "")
    .toLowerCase()
    .trim();
  return email ? `${prefix}:${email}` : ipKeyOf(req);
};

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
  // keyOf resolves the account from req.user or, before `protect` has run, from the
  // bearer token; it falls back to the IPv6-normalised address for anonymous callers.
  keyGenerator: keyOf,
  // A CODE the client can branch on, so it can say "you're going too fast, wait a
  // moment" instead of "couldn't reach Aria".
  message: {
    code: "RATE_LIMITED",
    message: "That's a lot of messages in a short time. Give it a minute and try again.",
  },
});

module.exports = {
  conversationLimiter,
  ipKeyOf,
  attachRateKey,
  keyOf,
  isAccountScoped,
  emailKeyOf,
};
