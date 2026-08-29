const express = require("express");
const request = require("supertest");

// The rate limiter that broke real builds.
//
// /api/coach used to sit behind aiLimiter: 20 requests per hour, keyed by IP, across the
// WHOLE router. coach.controller's own buildAllowance comment says "a real CV build uses
// ~40 turns" — so a single build could not finish, and on a shared mobile carrier IP
// several users drained one budget between them.
//
// This suite does NOT mock express-rate-limit (every other backend suite does, which is
// exactly why the misconfiguration went unnoticed for so long). It exercises the real
// middleware against a stub app.
jest.unmock("express-rate-limit");

const { conversationLimiter } = require("../src/middleware/rateLimit.middleware");

// A stub of the real mount order: auth sets req.user, THEN the limiter runs.
const appFor = (userIdOf) => {
  const app = express();
  app.set("trust proxy", true);
  app.use((req, res, next) => {
    const id = userIdOf(req);
    if (id) req.user = { id };
    next();
  });
  app.post("/chat", conversationLimiter, (req, res) => res.json({ ok: true }));
  return app;
};

describe("the conversation limiter", () => {
  it("lets a whole CV build through", async () => {
    // ~40 turns is a normal build. The old cap was 20 for the entire hour.
    const app = appFor(() => "user-a");
    for (let turn = 0; turn < 45; turn += 1) {
      const res = await request(app).post("/chat");
      if (res.statusCode !== 200) throw new Error(`turn ${turn + 1} was blocked (${res.statusCode})`);
    }
  });

  it("keys on the ACCOUNT, not the address", async () => {
    // The CGNAT case: two people, one carrier IP. One heavy user must not lock out the
    // other — which is what per-IP counting did.
    let current = "heavy";
    const app = appFor(() => current);
    for (let i = 0; i < 200; i += 1) await request(app).post("/chat");
    expect((await request(app).post("/chat")).statusCode).toBe(429);

    current = "bystander";
    expect((await request(app).post("/chat")).statusCode).toBe(200);
  });

  it("still stops a runaway client, and says why", async () => {
    const app = appFor(() => "user-c");
    for (let i = 0; i < 200; i += 1) await request(app).post("/chat");

    const res = await request(app).post("/chat");
    expect(res.statusCode).toBe(429);
    // A CODE, so the client can say "wait a minute" rather than falling through to its
    // generic "couldn't reach Aria" — the thing that made a limit look like an outage.
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("falls back to the address when nobody is signed in", async () => {
    const app = appFor(() => null);
    expect((await request(app).post("/chat")).statusCode).toBe(200);
  });
});
