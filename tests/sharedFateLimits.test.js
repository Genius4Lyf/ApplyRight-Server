const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

// THE LIMITS EVERYONE SHARED.
//
// Every rate limiter in this API counted per IP address. On a Nigerian mobile network
// that is not a person: carrier-grade NAT puts thousands of subscribers behind a handful
// of public addresses, so each cap was really a cap on the whole carrier, and the first
// user through the door spent everybody else's budget. It had already surfaced once, as
// signups failing with "we could not send the code".
//
// Like tests/coachRateLimit.test.js, this suite does NOT mock express-rate-limit — every
// other backend suite does, which is exactly why these misconfigurations survived so
// long. It exercises the real middleware.
jest.unmock("express-rate-limit");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-rate-limit-keys";

const {
  attachRateKey,
  keyOf,
  isAccountScoped,
  emailKeyOf,
} = require("../src/middleware/rateLimit.middleware");

const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET);

// A stub of app.js's real mount order: attachRateKey first, then a limiter, and only
// then anything resembling `protect`. The whole point of the change is that the limiter
// can identify the caller at a point where req.user does not exist yet.
const appWithGlobalLimiter = ({ accountLimit, ipLimit }) => {
  const app = express();
  app.set("trust proxy", true);
  app.use(attachRateKey);
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      keyGenerator: keyOf,
      limit: (req) => (isAccountScoped(req) ? accountLimit : ipLimit),
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
  app.get("/anything", (req, res) => res.json({ ok: true, key: req.rateKey }));
  return app;
};

const asAccount = (app, id) =>
  request(app)
    .get("/anything")
    .set("Authorization", `Bearer ${tokenFor(id)}`);

describe("the app-level limiters", () => {
  it("identifies the account from the token, before any route has run protect", async () => {
    const app = appWithGlobalLimiter({ accountLimit: 5, ipLimit: 5 });
    const res = await asAccount(app, "abc123");

    // This is the crux. globalLimiter and the /api/ai limiter are mounted with
    // app.use(), so they run BEFORE the route's protect middleware sets req.user. If the
    // key could only come from req.user, every request would fall back to the address and
    // the fix would be invisible in production while passing every unit test.
    expect(res.body.key).toEqual({ key: "user:abc123", scope: "account" });
  });

  it("does not let one heavy user lock out everyone on the same carrier", async () => {
    const app = appWithGlobalLimiter({ accountLimit: 5, ipLimit: 5 });

    for (let i = 0; i < 5; i += 1) await asAccount(app, "heavy");
    expect((await asAccount(app, "heavy")).statusCode).toBe(429);

    // Same address, different person. Under the old per-IP counting this was a 429 for
    // something a stranger did.
    expect((await asAccount(app, "bystander")).statusCode).toBe(200);
  });

  it("will not accept a forged or expired token as an identity", async () => {
    const app = appWithGlobalLimiter({ accountLimit: 100, ipLimit: 3 });

    // If garbage counted as an account, a client could mint a brand-new budget every
    // time it minted a brand-new fake token — an unlimited bypass of every limiter in
    // the app. Junk must land in the shared address bucket instead.
    const junk = () =>
      request(app).get("/anything").set("Authorization", "Bearer not.a.real.token");

    for (let i = 0; i < 3; i += 1) await junk();
    expect((await junk()).statusCode).toBe(429);
  });

  it("gives anonymous traffic a wider ceiling, because it really is shared", async () => {
    // Signed-out requests are the landing page, login and signup for everyone behind one
    // address, so they get the larger of the two budgets.
    const app = appWithGlobalLimiter({ accountLimit: 2, ipLimit: 6 });

    for (let i = 0; i < 6; i += 1) {
      expect((await request(app).get("/anything")).statusCode).toBe(200);
    }
    expect((await request(app).get("/anything")).statusCode).toBe(429);
  });
});

// The signup and login routes have no account to count against — nobody is signed in
// yet. They do, however, name the thing being abused: an email address, in the body.
const appWithEmailLimiter = (prefix, max, opts = {}) => {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: emailKeyOf(prefix),
      ...opts,
    })
  );
  app.post("/", (req, res) => {
    if (req.body.fail) return res.status(401).json({ ok: false });
    return res.json({ ok: true });
  });
  return app;
};

describe("the signed-out limiters", () => {
  it("does not make strangers on one carrier share a signup budget", async () => {
    const app = appWithEmailLimiter("auth", 3);
    const signup = (email) => request(app).post("/").send({ email });

    for (let i = 0; i < 3; i += 1) await signup("first@example.com");
    expect((await signup("first@example.com")).statusCode).toBe(429);

    // The next person to open the signup form on the same network. This is the exact
    // failure the user reported, and per-IP it returned 429 to someone who had done
    // nothing at all — on the one page where a blocked stranger simply leaves.
    expect((await signup("second@example.com")).statusCode).toBe(200);
  });

  it("still stops one address being hammered", async () => {
    const app = appWithEmailLimiter("auth", 3);
    const signup = () => request(app).post("/").send({ email: "target@example.com" });

    for (let i = 0; i < 3; i += 1) await signup();
    expect((await signup()).statusCode).toBe(429);
  });

  it("treats one address as one budget however it is typed", async () => {
    // Or "A@x.com", " a@x.com " and "a@x.com" would each get a fresh allowance, and the
    // limiter would be trivially defeated by pressing shift.
    const app = appWithEmailLimiter("auth", 2);
    await request(app).post("/").send({ email: "Person@Example.com" });
    await request(app).post("/").send({ email: "  person@example.com  " });

    const res = await request(app).post("/").send({ email: "person@example.com" });
    expect(res.statusCode).toBe(429);
  });

  it("locks the account being guessed at, not the network it is guessed from", async () => {
    const app = appWithEmailLimiter("login", 3, { skipSuccessfulRequests: true });
    const wrongPassword = (email) => request(app).post("/").send({ email, fail: true });

    for (let i = 0; i < 3; i += 1) await wrongPassword("victim@example.com");
    expect((await wrongPassword("victim@example.com")).statusCode).toBe(429);

    // Per IP, a few people fat-fingering their own passwords could shut an entire
    // carrier out of the login page for fifteen minutes — while an attacker on any other
    // network carried on undisturbed.
    expect((await wrongPassword("someone.else@example.com")).statusCode).toBe(401);
  });

  it("falls back to the address when the body names no one", async () => {
    // /resetpassword carries a token rather than an email. Its real protection is the
    // secret in that token; the counter just needs a key it can use.
    const app = appWithEmailLimiter("auth", 2);
    await request(app).post("/").send({ token: "x" });
    await request(app).post("/").send({ token: "y" });

    expect((await request(app).post("/").send({ token: "z" })).statusCode).toBe(429);
  });
});

// A guard, not a behaviour test. The bug this suite exists for was not one bad limiter,
// it was the DEFAULT: reach for express-rate-limit, get per-IP counting, ship it. Adding
// the next limiter without a keyGenerator would quietly reintroduce the whole class.
describe("every limiter in the app declares who it counts", () => {
  const fs = require("fs");
  const path = require("path");

  const FILES = [
    "src/app.js",
    "src/routes/auth.routes.js",
    "src/routes/studio.routes.js",
    "src/middleware/rateLimit.middleware.js",
  ];

  it.each(FILES)("%s", (file) => {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const blocks = source.split("rateLimit({").slice(1);
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const body = block.slice(0, block.indexOf("});"));
      // Deliberately per-IP limiters (the backstops behind the per-email ones) satisfy
      // this too — they say so explicitly with ipKeyOf rather than defaulting into it.
      expect(body).toContain("keyGenerator");
    }
  });
});
