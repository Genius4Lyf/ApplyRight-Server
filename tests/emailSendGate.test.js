const { pacedSend, isRetryableSendError } = require("../src/utils/email.service");

// The gate that stopped concurrent signups from knocking each other out.
//
// Resend allows ~2 requests/second. Every send in email.service used to hit the API
// directly, so two people reaching the signup form in the same second raced and the
// loser got a 429 — shown to them as "We could not send the code right now."
//
// Real timers, deliberately: the whole behaviour under test IS timing. The spacing is
// 600ms, so these run in a couple of seconds rather than instantly.
jest.setTimeout(20000);

describe("which failures are worth retrying", () => {
  it("retries a rate limit, however it is reported", () => {
    expect(isRetryableSendError({ statusCode: 429 })).toBe(true);
    expect(isRetryableSendError({ name: "rate_limit_exceeded" })).toBe(true);
    expect(isRetryableSendError({ message: "Too many requests" })).toBe(true);
  });

  it("retries a server fault and a dropped connection", () => {
    expect(isRetryableSendError({ statusCode: 503 })).toBe(true);
    expect(isRetryableSendError({ message: "socket hang up" })).toBe(true);
    expect(isRetryableSendError(new Error("ECONNRESET"))).toBe(true);
  });

  it("does NOT retry a permanent rejection", () => {
    // A suppressed recipient, an unverified domain or a bad address fails identically
    // three times. Retrying only makes the user wait longer for the same answer.
    expect(isRetryableSendError({ statusCode: 403, message: "domain is not verified" })).toBe(
      false
    );
    expect(isRetryableSendError({ statusCode: 422, message: "Invalid `to` field" })).toBe(false);
    expect(isRetryableSendError(null)).toBe(false);
  });
});

describe("concurrent sends are paced instead of colliding", () => {
  it("spaces simultaneous sends apart rather than firing them together", async () => {
    // Three people hitting signup at the same instant — the exact reported scenario.
    const at = [];
    const task = () => {
      at.push(Date.now());
      return Promise.resolve({ data: { id: "x" } });
    };

    await Promise.all([pacedSend(task, "a"), pacedSend(task, "b"), pacedSend(task, "c")]);

    expect(at).toHaveLength(3);
    // Each send waits out the spacing behind the one before it. Allowing a little slack
    // for timer imprecision, but a collision would show as a gap near zero.
    expect(at[1] - at[0]).toBeGreaterThan(400);
    expect(at[2] - at[1]).toBeGreaterThan(400);
  });

  it("keeps the queue alive after one send fails", async () => {
    // A rejected recipient must not wedge everyone queued behind them.
    const boom = () => Promise.reject(new Error("Invalid `to` field"));
    const ok = jest.fn(() => Promise.resolve({ data: { id: "ok" } }));

    const failed = pacedSend(boom, "bad");
    const after = pacedSend(ok, "good");

    await expect(failed).resolves.toHaveProperty("error");
    await expect(after).resolves.toEqual({ data: { id: "ok" } });
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("a rate limit that gets through anyway", () => {
  it("backs off and succeeds on the retry", async () => {
    // Pacing only covers THIS process. A second instance, or a dashboard broadcast,
    // can still spend the allowance underneath us — so the retry is what actually
    // saves the user's signup.
    let calls = 0;
    const flaky = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ error: { statusCode: 429, message: "rate" } });
      return Promise.resolve({ data: { id: "sent" } });
    };

    const res = await pacedSend(flaky, "flaky");

    expect(calls).toBe(2);
    expect(res.data).toEqual({ id: "sent" });
    expect(res.error).toBeFalsy();
  });

  it("gives up after three attempts and returns the last error", async () => {
    const always = jest.fn(() => Promise.resolve({ error: { statusCode: 429, message: "rate" } }));

    const res = await pacedSend(always, "always");

    expect(always).toHaveBeenCalledTimes(3);
    expect(res.error).toMatchObject({ statusCode: 429 });
  });

  it("returns a permanent failure immediately, without burning retries", async () => {
    const rejected = jest.fn(() =>
      Promise.resolve({ error: { statusCode: 422, message: "Invalid `to` field" } })
    );

    const res = await pacedSend(rejected, "rejected");

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(res.error).toMatchObject({ statusCode: 422 });
  });
});
