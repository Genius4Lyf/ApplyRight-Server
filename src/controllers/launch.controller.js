// Pre-launch campaign operations: the early-bird credit grant and the one-time
// "we're live" announcement email.
//
// Both are IRREVERSIBLE bulk actions over the whole user table, so everything here is
// built around one idea: the per-user marker field IS the idempotency mechanism, and it
// is always part of the update FILTER rather than something written afterwards. That
// makes a double-click, a concurrent run, and a crash mid-way all behave the same way —
// the work that already happened is skipped and the rest resumes.
//
// Kept out of admin.controller.js (already 1300+ lines) because this is a self-contained
// campaign concern with its own preconditions.

const User = require("../models/User");
const Transaction = require("../models/Transaction");
const SettingsService = require("../services/settings.service");
const { TRANSACTION_TYPES } = require("../config/transactionTypes");
const {
  sendLaunchAnnouncementBatch,
  isEmailConfigured,
  getFromAddress,
} = require("../utils/email.service");

// Hard ceiling on launch mail per calendar day.
//
// The Resend plan allows ~100 emails/day in total, and SIGNUP VERIFICATION CODES draw
// from the same allowance. A single 214-person blast would eat the whole day and leave
// every new registration unable to receive its code — the campaign would break the
// thing the campaign is for. Half the quota goes to the announcement, half stays free
// for people signing up.
//
// The send is resumable by design (per-user markers), so the announcement simply
// finishes over several days instead of failing on day one.
const DAILY_LAUNCH_EMAIL_CAP = 50;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// Resend's batch endpoint takes at most 100 messages per call.
const EMAIL_BATCH_SIZE = 100;
// Small pause between batches. The default Resend plan allows roughly 2 requests/second
// and a batch counts as ONE request, so this is comfortable headroom rather than a
// throttle we are fighting.
const BATCH_PAUSE_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Admins are excluded from both operations: they hold 9999 credits by construction and
// the launch mail is for customers. `$ne: "admin"` rather than `{ role: "user" }` is
// deliberate — 46 accounts predate the role field and carry role: null, so an equality
// filter would silently skip a fifth of the user base.
const AUDIENCE = { role: { $ne: "admin" } };

// @desc    Counts for the admin launch screen.
// @route   GET /api/admin/launch/status
// @access  Private/Admin
exports.getLaunchStatus = async (req, res) => {
  try {
    const settings = await SettingsService.getSettings();
    const [totalUsers, pendingBonus, pendingEmail, claimedUnsent, sentToday] = await Promise.all([
      User.countDocuments(AUDIENCE),
      User.countDocuments({ ...AUDIENCE, launchBonusGrantedAt: null }),
      User.countDocuments({ ...AUDIENCE, launchEmailSentAt: null }),
      // Claimed by a run that then died before confirming. Precisely requeueable.
      User.countDocuments({
        ...AUDIENCE,
        launchEmailSentAt: null,
        launchEmailClaimedAt: { $ne: null },
      }),
      // Derived from the markers themselves rather than a counter, so it cannot drift
      // out of step with what was actually sent.
      User.countDocuments({ ...AUDIENCE, launchEmailSentAt: { $gte: startOfToday() } }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        launch: {
          enabled: settings.launch?.enabled === true,
          date: settings.launch?.date || null,
          bonusCredits: settings.launch?.bonusCredits ?? 50,
        },
        maintenanceMode: settings.features?.maintenanceMode === true,
        emailConfigured: isEmailConfigured(),
        fromAddress: getFromAddress(),
        totalUsers,
        pendingBonus,
        pendingEmail,
        claimedUnsent,
        sentToday,
        dailyCap: DAILY_LAUNCH_EMAIL_CAP,
        sendableToday: Math.max(0, Math.min(pendingEmail, DAILY_LAUNCH_EMAIL_CAP - sentToday)),
        bonusTotalIfRun: pendingBonus * (settings.launch?.bonusCredits ?? 50),
      },
    });
  } catch (err) {
    console.error("Launch status error:", err);
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    One-time flat early-bird credit grant to every existing account.
// @route   POST /api/admin/launch/backfill
// @access  Private/Admin
exports.backfillLaunchBonus = async (req, res) => {
  try {
    const settings = await SettingsService.getSettings();

    // Refuse once the campaign is over, or a re-run after launch would quietly hand
    // +50 to everyone who has signed up since.
    if (settings.launch?.enabled !== true) {
      return res.status(409).json({
        success: false,
        code: "LAUNCH_OFF",
        message: "Turn the pre-launch campaign on before granting the bonus.",
      });
    }

    const amount = Number(settings.launch.bonusCredits ?? 50);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid bonus amount" });
    }

    const targets = await User.find({ ...AUDIENCE, launchBonusGrantedAt: null })
      .select("_id")
      .lean();

    let granted = 0;
    let skipped = 0;
    const failures = [];

    for (const { _id } of targets) {
      try {
        // LEDGER FIRST, and deliberately so. Crash after this but before the $inc and
        // you get a ledger row with no credits — visible, and the retry still grants
        // them because the marker is untouched. The reverse order would leave credits
        // with no ledger row AND a set marker, which no re-run can ever repair.
        //
        // externalTxId doubles as the dedupe key: it is unique+sparse, so a retry that
        // re-inserts the same row fails with E11000 instead of double-counting.
        try {
          await Transaction.create({
            userId: _id,
            amount,
            type: TRANSACTION_TYPES.LAUNCH_BONUS,
            description: `Early-bird launch bonus (+${amount} credits)`,
            status: "completed",
            externalTxId: `launch:bonus:${_id}`,
          });
        } catch (err) {
          // Already ledgered by an earlier partial run — fine, carry on to the grant.
          if (err.code !== 11000) throw err;
        }

        // The filter IS the lock. Only the call that flips null → a date grants the
        // credits, so two concurrent runs cannot both pay the same account, and this
        // holds at the database level across multiple backend instances.
        const claim = await User.updateOne(
          { _id, launchBonusGrantedAt: null },
          { $inc: { credits: amount }, $set: { launchBonusGrantedAt: new Date() } }
        );

        if (claim.modifiedCount === 1) granted += 1;
        else skipped += 1;
      } catch (err) {
        failures.push({ userId: String(_id), error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        amount,
        eligible: targets.length,
        granted,
        skipped,
        creditsIssued: granted * amount,
        failed: failures.length,
        failures: failures.slice(0, 10),
      },
      message: `Granted ${amount} credits to ${granted} account(s).`,
    });
  } catch (err) {
    console.error("Launch backfill error:", err);
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};

// Where the pre-flight test lands. Deliberately a fixed inbox rather than the signed-in
// admin's own address: the point of the test is to read the mail on a real client before
// 200 strangers do, and that has to be an inbox someone actually opens, whichever admin
// account happens to be logged in. Override per-environment with LAUNCH_TEST_EMAIL.
const TEST_RECIPIENT = process.env.LAUNCH_TEST_EMAIL || "udofiadaniel07@gmail.com";

// @desc    The one-click "we're live" email. `mode: "test"` sends only to the caller.
// @route   POST /api/admin/launch/announce
// @access  Private/Admin
exports.sendLaunchAnnouncement = async (req, res) => {
  try {
    const { mode, force } = req.body || {};
    const settings = await SettingsService.getSettings();
    const bonusCredits = settings.launch?.bonusCredits ?? 50;

    // A missing key makes every send a SILENT no-op (the Resend client is null). Sending
    // into that would stamp every user as emailed while nobody received anything, and
    // the markers would then permanently block a real send. Hard-fail instead.
    if (!isEmailConfigured()) {
      return res.status(503).json({
        success: false,
        code: "EMAIL_NOT_CONFIGURED",
        message: "RESEND_API_KEY is not set — no email would actually be delivered.",
      });
    }

    // resend.dev is Resend's shared testing sender. A 200-recipient blast from it is a
    // spam-folder guarantee and can get the account limited.
    const from = getFromAddress();
    if (/resend\.dev/i.test(from)) {
      return res.status(503).json({
        success: false,
        code: "SENDER_UNVERIFIED",
        message: `Set RESEND_FROM_EMAIL to a verified domain (currently ${from}).`,
      });
    }

    // --- Test send: one message to the admin, marks nobody.
    if (mode === "test") {
      const result = await sendLaunchAnnouncementBatch([
        {
          email: TEST_RECIPIENT,
          firstName: req.user.firstName,
          credits: bonusCredits,
        },
      ]);
      if (result.error) {
        return res.status(502).json({ success: false, code: "SEND_FAILED", message: result.error });
      }
      return res.status(200).json({
        success: true,
        data: { sent: 1, test: true },
        message: `Test sent to ${TEST_RECIPIENT}.`,
      });
    }

    // --- Live send preconditions.
    //
    // The single most valuable guard here: emailing everyone "we're live" while the app
    // still 503s them sends the entire audience to a maintenance page, and you only get
    // one shot at a launch announcement.
    if (settings.features?.maintenanceMode === true && force !== true) {
      return res.status(409).json({
        success: false,
        code: "MAINTENANCE_STILL_ON",
        message: "Turn maintenance mode OFF first, or the email invites everyone to a closed site.",
      });
    }

    const pendingBonus = await User.countDocuments({ ...AUDIENCE, launchBonusGrantedAt: null });
    if (pendingBonus > 0 && force !== true) {
      return res.status(409).json({
        success: false,
        code: "BACKFILL_INCOMPLETE",
        message: `${pendingBonus} account(s) have not received the bonus yet. The email promises credits they do not have.`,
      });
    }

    // Whatever is left of today's allowance, so verification codes keep working.
    const sentToday = await User.countDocuments({
      ...AUDIENCE,
      launchEmailSentAt: { $gte: startOfToday() },
    });
    const allowanceLeft = DAILY_LAUNCH_EMAIL_CAP - sentToday;
    if (allowanceLeft <= 0) {
      return res.status(429).json({
        success: false,
        code: "DAILY_CAP_REACHED",
        message: `Today's ${DAILY_LAUNCH_EMAIL_CAP}-email allowance is used up. The rest go out tomorrow.`,
      });
    }

    // Oldest accounts first, so the queue drains in a predictable order across days.
    const recipients = await User.find({
      ...AUDIENCE,
      launchEmailSentAt: null,
      email: { $exists: true, $ne: "" },
    })
      .select("_id email firstName")
      .sort({ createdAt: 1 })
      .limit(allowanceLeft)
      .lean();

    let sent = 0;
    let failed = 0;
    let lastError = null;

    for (let i = 0; i < recipients.length; i += EMAIL_BATCH_SIZE) {
      const batch = recipients.slice(i, i + EMAIL_BATCH_SIZE);
      const ids = batch.map((u) => u._id);

      // CLAIM before sending. A crash between "Resend accepted" and "marker written"
      // would otherwise re-send to up to 100 real people on the retry. Claiming first
      // makes the residual crash window `claimed but not confirmed`, which is precisely
      // identifiable and requeueable rather than silently duplicated.
      const claim = await User.updateMany(
        { _id: { $in: ids }, launchEmailSentAt: null, launchEmailClaimedAt: null },
        { $set: { launchEmailClaimedAt: new Date() } }
      );
      if (claim.modifiedCount === 0) continue; // another run owns this batch

      const result = await sendLaunchAnnouncementBatch(
        batch.map((u) => ({ email: u.email, firstName: u.firstName, credits: bonusCredits }))
      );

      if (result.error) {
        // RELEASE the claim so the batch stays retryable, then stop: a domain, quota or
        // auth error fails identically for every remaining batch, and hammering it only
        // costs sender reputation.
        await User.updateMany(
          { _id: { $in: ids }, launchEmailSentAt: null },
          { $set: { launchEmailClaimedAt: null } }
        );
        failed += batch.length;
        lastError = result.error;
        break;
      }

      // CONFIRM.
      await User.updateMany({ _id: { $in: ids } }, { $set: { launchEmailSentAt: new Date() } });
      sent += batch.length;

      if (i + EMAIL_BATCH_SIZE < recipients.length) await sleep(BATCH_PAUSE_MS);
    }

    const remaining = await User.countDocuments({ ...AUDIENCE, launchEmailSentAt: null });

    return res.status(200).json({
      success: true,
      data: { sent, failed, remaining, lastError, dailyCap: DAILY_LAUNCH_EMAIL_CAP },
      message: lastError
        ? `Sent ${sent}, then stopped: ${lastError}`
        : remaining > 0
          ? `Sent ${sent} (today's cap). ${remaining} to go — run this again tomorrow.`
          : `Launch announcement sent to ${sent} account(s).`,
    });
  } catch (err) {
    console.error("Launch announce error:", err);
    return res.status(500).json({ success: false, message: "Server Error" });
  }
};
