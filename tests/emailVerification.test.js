const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const EmailVerification = require("../src/models/EmailVerification");
const SettingsService = require("../src/services/settings.service");
const emailService = require("../src/utils/email.service");
const bcrypt = require("bcryptjs");

// Signup now proves the mailbox BEFORE the account exists. That ordering is the entire
// anti-bot measure, so the tests that matter are the ones asserting no account can be
// created without a verified, unexpired, unconsumed record — and that the record cannot
// be brute-forced or replayed.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/EmailVerification");
jest.mock("../src/services/settings.service");
jest.mock("../src/utils/email.service");
jest.mock("bcryptjs");

const EMAIL = "newperson@gmail.com";

const settings = () => ({
  features: { maintenanceMode: false },
  credits: { signupBonus: 20, referralBonus: 10 },
  launch: { enabled: false, date: null, bonusCredits: 50 },
});

const verifiedRecord = (over = {}) => ({
  _id: "rec1",
  email: EMAIL,
  codeHash: "hashed",
  attempts: 0,
  verifiedAt: new Date(),
  consumedAt: null,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  SettingsService.getSettings.mockResolvedValue(settings());
  emailService.sendVerificationCode.mockResolvedValue(true);

  bcrypt.genSalt.mockResolvedValue("salt");
  bcrypt.hash.mockResolvedValue("hashed");
  bcrypt.compare.mockResolvedValue(true);

  // findOne is awaited directly in register (`await User.findOne({email})`) and chained
  // in request-verification (`.select("_id")`). A promise carrying a `.select` satisfies
  // both, so "no such user yet" means the same thing on either path.
  User.findOne.mockImplementation(() => {
    const p = Promise.resolve(null);
    p.select = jest.fn().mockResolvedValue(null);
    return p;
  });
  EmailVerification.findOneAndUpdate.mockResolvedValue(verifiedRecord());
  EmailVerification.findOne.mockResolvedValue(null);
  EmailVerification.updateOne.mockResolvedValue({ modifiedCount: 1 });
  EmailVerification.deleteOne.mockResolvedValue({ deletedCount: 1 });
});

describe("POST /auth/request-verification", () => {
  it("emails a code and stores only a HASH of it", async () => {
    const res = await request(app).post("/api/auth/request-verification").send({ email: EMAIL });

    expect(res.statusCode).toBe(200);
    expect(emailService.sendVerificationCode).toHaveBeenCalledTimes(1);

    const [sentTo, sentCode] = emailService.sendVerificationCode.mock.calls[0];
    expect(sentTo).toBe(EMAIL);
    expect(sentCode).toMatch(/^\d{6}$/);

    // The plaintext code must never be persisted — a database dump would otherwise hand
    // out live signup codes.
    const stored = EmailVerification.findOneAndUpdate.mock.calls[0][1];
    expect(stored.codeHash).toBe("hashed");
    expect(JSON.stringify(stored)).not.toContain(sentCode);
  });

  it("resets the attempt counter so a fresh code is not born half-burned", async () => {
    await request(app).post("/api/auth/request-verification").send({ email: EMAIL });
    const stored = EmailVerification.findOneAndUpdate.mock.calls[0][1];
    expect(stored.attempts).toBe(0);
    expect(stored.verifiedAt).toBe(null);
    expect(stored.consumedAt).toBe(null);
  });

  it("refuses an address that already has an account", async () => {
    User.findOne.mockImplementation(() => {
      const p = Promise.resolve({ _id: "u1" });
      p.select = jest.fn().mockResolvedValue({ _id: "u1" });
      return p;
    });

    const res = await request(app).post("/api/auth/request-verification").send({ email: EMAIL });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("EMAIL_TAKEN");
    expect(emailService.sendVerificationCode).not.toHaveBeenCalled();
  });

  it("drops the record when the send fails, leaving no code nobody can receive", async () => {
    emailService.sendVerificationCode.mockRejectedValue(new Error("EMAIL_UNAVAILABLE"));

    const res = await request(app).post("/api/auth/request-verification").send({ email: EMAIL });

    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("EMAIL_UNAVAILABLE");
    expect(EmailVerification.deleteOne).toHaveBeenCalledWith({ email: EMAIL });
  });

  it("rejects a malformed address before spending a send", async () => {
    const res = await request(app).post("/api/auth/request-verification").send({ email: "nope" });
    expect(res.statusCode).toBe(400);
    expect(emailService.sendVerificationCode).not.toHaveBeenCalled();
  });
});

describe("POST /auth/verify-code", () => {
  it("marks the record verified and EXTENDS its life to finish the form", async () => {
    EmailVerification.findOne.mockResolvedValue(verifiedRecord({ verifiedAt: null }));

    const res = await request(app)
      .post("/api/auth/verify-code")
      .send({ email: EMAIL, code: "123456" });

    expect(res.statusCode).toBe(200);
    const update = EmailVerification.updateOne.mock.calls[0][1].$set;
    expect(update.verifiedAt).toBeInstanceOf(Date);
    // Without the extension the TTL could sweep the proof away between entering the code
    // and pressing "create account", failing someone who did everything right.
    expect(update.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 1000);
  });

  it("counts a wrong code against the attempt cap", async () => {
    EmailVerification.findOne.mockResolvedValue(verifiedRecord({ verifiedAt: null }));
    bcrypt.compare.mockResolvedValue(false);

    const res = await request(app)
      .post("/api/auth/verify-code")
      .send({ email: EMAIL, code: "000000" });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("CODE_INVALID");
    expect(EmailVerification.updateOne.mock.calls[0][1]).toEqual({ $inc: { attempts: 1 } });
  });

  it("burns the code once the attempt cap is hit", async () => {
    // Six digits is only one-in-a-million PER GUESS. This is what stops the guessing.
    EmailVerification.findOne.mockResolvedValue(verifiedRecord({ verifiedAt: null, attempts: 5 }));

    const res = await request(app)
      .post("/api/auth/verify-code")
      .send({ email: EMAIL, code: "123456" });

    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_ATTEMPTS");
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it("treats an expired record the same as no record at all", async () => {
    EmailVerification.findOne.mockResolvedValue(
      verifiedRecord({ verifiedAt: null, expiresAt: new Date(Date.now() - 1000) })
    );

    const res = await request(app)
      .post("/api/auth/verify-code")
      .send({ email: EMAIL, code: "123456" });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("CODE_EXPIRED");
  });
});

describe("POST /auth/register — the account cannot exist before the mailbox is proved", () => {
  const body = { email: EMAIL, password: "Password1" };

  it("REFUSES when there is no verified record", async () => {
    EmailVerification.findOne.mockResolvedValue(null);

    const res = await request(app).post("/api/auth/register").send(body);

    // The whole anti-bot measure: a script can POST here all day and get nowhere.
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(User.create).not.toHaveBeenCalled();
  });

  it("REFUSES when the verified record has expired", async () => {
    EmailVerification.findOne.mockResolvedValue(
      verifiedRecord({ expiresAt: new Date(Date.now() - 1000) })
    );

    const res = await request(app).post("/api/auth/register").send(body);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(User.create).not.toHaveBeenCalled();
  });

  it("only looks at records that are verified AND unconsumed", async () => {
    EmailVerification.findOne.mockResolvedValue(null);
    await request(app).post("/api/auth/register").send(body);

    // Replay protection lives in this filter: a consumed record must not register a
    // second account.
    expect(EmailVerification.findOne).toHaveBeenCalledWith({
      email: EMAIL,
      consumedAt: null,
      verifiedAt: { $ne: null },
    });
  });
});
