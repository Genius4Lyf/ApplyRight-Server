const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Transaction = require("../src/models/Transaction");
const SettingsService = require("../src/services/settings.service");
const emailService = require("../src/utils/email.service");
const jwt = require("jsonwebtoken");

// The pre-launch campaign hands out real credits and sends real email in bulk, and both
// are irreversible. Everything pinned here is about the two properties that make that
// survivable: the per-user marker is part of the update FILTER (so a re-run grants
// nothing twice), and the send claims before it sends (so a crash cannot duplicate mail).
//
// SettingsService is mocked directly rather than the SystemSettings model: automocking
// the model no-ops its `getInstance` static, which makes checkMaintenanceMode fail open
// on every request and silently invalidates the whole suite. That already cost one
// debugging pass on tests/maintenance.test.js.
jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/Transaction");
jest.mock("../src/services/settings.service");
jest.mock("../src/utils/email.service");
jest.mock("jsonwebtoken");

const ADMIN_ID = "60c72b2f9b1d8b2bad6e1a11";

const settings = (over = {}) => ({
  features: { maintenanceMode: false },
  credits: { signupBonus: 20, referralBonus: 10 },
  launch: { enabled: true, date: null, bonusCredits: 50 },
  ...over,
});

// A chainable User.find(...) stub: .select().lean(), .select().sort().lean().
const findReturning = (rows) => {
  const lean = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ lean });
  const sort = jest.fn().mockReturnValue({ lean, limit });
  const select = jest.fn().mockReturnValue({ lean, sort, limit });
  return { select, sort, lean, limit };
};

const asAdmin = (req) => req.set("Authorization", "Bearer admin-token");

beforeEach(() => {
  jest.clearAllMocks();

  // `protect` on the admin router resolves the caller.
  jwt.verify.mockReturnValue({ id: ADMIN_ID });
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({
      _id: ADMIN_ID,
      id: ADMIN_ID,
      role: "admin",
      email: "admin@applyright.com",
      firstName: "Ada",
    }),
  });

  SettingsService.getSettings.mockResolvedValue(settings());
  emailService.isEmailConfigured.mockReturnValue(true);
  emailService.getFromAddress.mockReturnValue("ApplyRight <hello@applyright.com.ng>");
  emailService.sendLaunchAnnouncementBatch.mockResolvedValue({ sent: 0, error: null });

  User.countDocuments.mockResolvedValue(0);
  User.find.mockReturnValue(findReturning([]));
  User.updateOne.mockResolvedValue({ modifiedCount: 1 });
  User.updateMany.mockResolvedValue({ modifiedCount: 0 });
  Transaction.create.mockResolvedValue({});
});

describe("POST /admin/launch/backfill", () => {
  it("grants the bonus and marks each account in ONE atomic update", async () => {
    User.find.mockReturnValue(findReturning([{ _id: "u1" }, { _id: "u2" }]));

    const res = await asAdmin(request(app).post("/api/admin/launch/backfill"));

    expect(res.statusCode).toBe(200);
    expect(res.body.data.granted).toBe(2);
    expect(res.body.data.creditsIssued).toBe(100);

    // The filter IS the idempotency contract — pin it. Without the null check in the
    // FILTER (rather than a check-then-write), two concurrent runs both pay.
    const [filter, update] = User.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "u1", launchBonusGrantedAt: null });
    expect(update.$inc).toEqual({ credits: 50 });
    expect(update.$set.launchBonusGrantedAt).toBeInstanceOf(Date);
  });

  it("credits are $inc, never $set — a concurrent spend must not be clobbered", async () => {
    User.find.mockReturnValue(findReturning([{ _id: "u1" }]));
    await asAdmin(request(app).post("/api/admin/launch/backfill"));

    const update = User.updateOne.mock.calls[0][1];
    expect(update.$set.credits).toBeUndefined();
    expect(update.$inc.credits).toBe(50);
  });

  it("re-running grants nobody a second time", async () => {
    // Everyone already carries a marker, so the eligibility query returns nothing.
    User.find.mockReturnValue(findReturning([]));

    const res = await asAdmin(request(app).post("/api/admin/launch/backfill"));

    expect(res.body.data.granted).toBe(0);
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(Transaction.create).not.toHaveBeenCalled();
  });

  it("counts a lost race as skipped rather than granting twice", async () => {
    // Another run claimed the row between our find and our update.
    User.find.mockReturnValue(findReturning([{ _id: "u1" }]));
    User.updateOne.mockResolvedValue({ modifiedCount: 0 });

    const res = await asAdmin(request(app).post("/api/admin/launch/backfill"));

    expect(res.body.data.granted).toBe(0);
    expect(res.body.data.skipped).toBe(1);
  });

  it("targets non-admins, INCLUDING accounts whose role is null", async () => {
    User.find.mockReturnValue(findReturning([]));
    await asAdmin(request(app).post("/api/admin/launch/backfill"));

    // 46 live accounts predate the role field and carry role: null. `$ne: "admin"`
    // catches them; a `role: "user"` equality filter would silently skip a fifth of
    // the user base.
    expect(User.find.mock.calls[0][0]).toEqual({
      role: { $ne: "admin" },
      launchBonusGrantedAt: null,
    });
  });

  it("writes a ledger row with NO externalTxId null, and ledgers before granting", async () => {
    User.find.mockReturnValue(findReturning([{ _id: "u1" }]));
    await asAdmin(request(app).post("/api/admin/launch/backfill"));

    const row = Transaction.create.mock.calls[0][0];
    expect(row.type).toBe("launch_bonus");
    expect(row.amount).toBe(50);
    // The index is unique+sparse: a sparse index skips ABSENT fields but still indexes
    // an explicit null, so a second null row would collide with E11000.
    expect(row.externalTxId).toBe("launch:bonus:u1");
    expect(Object.prototype.hasOwnProperty.call(row, "externalTxId")).toBe(true);

    // Ledger first: a crash before the $inc leaves an explainable over-report that the
    // retry completes. The reverse leaves credits with no ledger row AND a set marker,
    // which no re-run can ever repair.
    expect(Transaction.create.mock.invocationCallOrder[0]).toBeLessThan(
      User.updateOne.mock.invocationCallOrder[0]
    );
  });

  it("tolerates a duplicate ledger row from an interrupted earlier run", async () => {
    User.find.mockReturnValue(findReturning([{ _id: "u1" }]));
    const dup = new Error("E11000 duplicate key");
    dup.code = 11000;
    Transaction.create.mockRejectedValue(dup);

    const res = await asAdmin(request(app).post("/api/admin/launch/backfill"));

    // Already ledgered — the grant must still complete rather than abort the run.
    expect(res.statusCode).toBe(200);
    expect(res.body.data.granted).toBe(1);
  });

  it("refuses to run once the campaign is switched off", async () => {
    SettingsService.getSettings.mockResolvedValue(settings({ launch: { enabled: false } }));

    const res = await asAdmin(request(app).post("/api/admin/launch/backfill"));

    // Otherwise a re-run after launch quietly hands +50 to everyone who has signed up
    // since, on top of what they already got.
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("LAUNCH_OFF");
    expect(User.updateOne).not.toHaveBeenCalled();
  });
});

describe("POST /admin/launch/announce", () => {
  const recipients = [{ _id: "u1", email: "a@x.com", firstName: "A" }];

  it("hard-fails when email is not configured, and marks NOBODY", async () => {
    emailService.isEmailConfigured.mockReturnValue(false);
    SettingsService.getSettings.mockResolvedValue(settings());

    const res = await asAdmin(request(app).post("/api/admin/launch/announce"));

    // A missing key makes every send a silent no-op. Sending into that would stamp the
    // whole user table as emailed while nobody received anything — and the markers
    // would then permanently block a real send.
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("EMAIL_NOT_CONFIGURED");
    expect(User.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to send from the shared resend.dev testing sender", async () => {
    emailService.getFromAddress.mockReturnValue("ApplyRight <onboarding@resend.dev>");

    const res = await asAdmin(request(app).post("/api/admin/launch/announce"));

    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe("SENDER_UNVERIFIED");
    expect(User.updateMany).not.toHaveBeenCalled();
  });

  it("refuses while maintenance mode is still ON", async () => {
    SettingsService.getSettings.mockResolvedValue(
      settings({ features: { maintenanceMode: true } })
    );

    const res = await asAdmin(request(app).post("/api/admin/launch/announce"));

    // The highest-value guard here: you get one launch announcement, and sending it
    // while the app still 503s everyone points the whole audience at a closed door.
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("MAINTENANCE_STILL_ON");
    expect(emailService.sendLaunchAnnouncementBatch).not.toHaveBeenCalled();
  });

  it("refuses while accounts are still missing their credits", async () => {
    User.countDocuments.mockResolvedValue(7);

    const res = await asAdmin(request(app).post("/api/admin/launch/announce"));

    // The email promises bonus credits; sending before the grant means they log in and
    // find they do not have them.
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("BACKFILL_INCOMPLETE");
  });

  it("claims BEFORE sending and confirms after", async () => {
    User.countDocuments.mockResolvedValue(0);
    User.find.mockReturnValue(findReturning(recipients));
    User.updateMany.mockResolvedValue({ modifiedCount: 1 });
    emailService.sendLaunchAnnouncementBatch.mockResolvedValue({ sent: 1, error: null });

    const res = await asAdmin(request(app).post("/api/admin/launch/announce"));

    expect(res.statusCode).toBe(200);
    expect(res.body.data.sent).toBe(1);

    // Claim first: without it, a crash between "Resend accepted" and "marker written"
    // re-sends to real people on the retry.
    const claimFilter = User.updateMany.mock.calls[0][0];
    expect(claimFilter.launchEmailSentAt).toBe(null);
    expect(claimFilter.launchEmailClaimedAt).toBe(null);
    expect(User.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      emailService.sendLaunchAnnouncementBatch.mock.invocationCallOrder[0]
    );

    // Confirm after.
    const confirm = User.updateMany.mock.calls[1][1];
    expect(confirm.$set.launchEmailSentAt).toBeInstanceOf(Date);
  });

  it("releases the claim when the send fails, so the batch stays retryable", async () => {
    User.countDocuments.mockResolvedValue(0);
    User.find.mockReturnValue(findReturning(recipients));
    User.updateMany.mockResolvedValue({ modifiedCount: 1 });
    emailService.sendLaunchAnnouncementBatch.mockResolvedValue({
      sent: 0,
      error: "domain not verified",
    });

    const res = await asAdmin(request(app).post("/api/admin/launch/announce"));

    expect(res.body.data.failed).toBe(1);
    expect(res.body.data.lastError).toMatch(/domain not verified/);
    // The release: claim cleared, and sentAt never written.
    const release = User.updateMany.mock.calls[1][1];
    expect(release.$set.launchEmailClaimedAt).toBe(null);
    expect(release.$set.launchEmailSentAt).toBeUndefined();
  });

  it("a test send goes to the pre-flight inbox and marks nobody", async () => {
    // The pre-flight goes to ONE fixed address, not to whichever admin clicked it —
    // the whole value of a test send is reading the mail on a real client first, so it
    // has to land somewhere someone actually opens.
    emailService.sendLaunchAnnouncementBatch.mockResolvedValue({ sent: 1, error: null });

    const res = await asAdmin(
      request(app).post("/api/admin/launch/announce").send({ mode: "test" })
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.test).toBe(true);

    const [recipients] = emailService.sendLaunchAnnouncementBatch.mock.calls[0];
    expect(recipients).toHaveLength(1);
    expect(recipients[0].email).toBe(process.env.LAUNCH_TEST_EMAIL || "udofiadaniel07@gmail.com");
    expect(recipients[0].credits).toBe(50);

    // Nobody is stamped: the test must not consume anyone's one announcement.
    expect(User.updateMany).not.toHaveBeenCalled();
  });

  it("sends at most the DAILY CAP, leaving quota for signup verification codes", async () => {
    // The Resend allowance (~100/day) is shared with the verification codes new
    // signups need. A single 214-person blast would eat the day and leave every new
    // registration unable to receive its code — the campaign breaking the thing the
    // campaign exists for.
    User.countDocuments.mockImplementation((filter) => {
      if (filter && filter.launchBonusGrantedAt === null) return Promise.resolve(0);
      if (filter && filter.launchEmailSentAt && filter.launchEmailSentAt.$gte)
        return Promise.resolve(0); // none sent yet today
      return Promise.resolve(0);
    });
    const chain = findReturning([]);
    User.find.mockReturnValue(chain);

    await asAdmin(request(app).post("/api/admin/launch/announce"));

    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it("refuses outright once today's allowance is spent", async () => {
    User.countDocuments.mockImplementation((filter) => {
      if (filter && filter.launchBonusGrantedAt === null) return Promise.resolve(0);
      if (filter && filter.launchEmailSentAt && filter.launchEmailSentAt.$gte)
        return Promise.resolve(50); // cap already reached today
      return Promise.resolve(0);
    });

    const res = await asAdmin(request(app).post("/api/admin/launch/announce"));

    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe("DAILY_CAP_REACHED");
    expect(emailService.sendLaunchAnnouncementBatch).not.toHaveBeenCalled();
  });

  it("skips accounts already emailed", async () => {
    User.countDocuments.mockResolvedValue(0);
    User.find.mockReturnValue(findReturning([]));

    const res = await asAdmin(request(app).post("/api/admin/launch/announce"));

    expect(res.body.data.sent).toBe(0);
    expect(emailService.sendLaunchAnnouncementBatch).not.toHaveBeenCalled();
    expect(User.find.mock.calls[0][0].launchEmailSentAt).toBe(null);
  });
});
