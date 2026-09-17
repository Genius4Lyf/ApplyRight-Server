// Aria Live — session minting and minute accounting for the spoken CV build.
//
// The money shape is lifted from interviewPrep.controller's reserve-then-reconcile, because
// it is correct and battle-tested: debit up front under a guarded update so a race loses
// cleanly, record WHICH bucket was debited, and settle against real usage at the end. Two
// things are deliberately different, and both are improvements the interview can't make:
//
//   1. A RESERVATION CANNOT STAY OPEN. The interview's does: if a client never calls
//      assess-interview, its reservation sits there fully debited forever. Here a settle
//      TIMER fires at the cap, and a stale reservation is swept on the next call attempt —
//      which also means a crashed call can never leave someone permanently locked out with
//      "a call is already in progress".
//
//   2. THE CLIENT CAN ONLY EVER REDUCE THE BILL. settleReservation clamps a reported
//      duration to what was reserved, so the worst a bad client achieves is paying full
//      price for a short call.
//
// What we do NOT have, and the interview does not either: a way to stop OUR OpenAI spend if
// a client holds the session past its reservation. The Realtime API hands the browser an
// ephemeral secret and never tells the server the session id, so there is nothing to hang up.
// The secret's short life is the only backstop. The abandoned gpt-live design could do this
// via a sideband, but it cost ~40% more per minute, which mattered more.
const crypto = require("crypto");
const UserModel = require("../models/User");
const Transaction = require("../models/Transaction");
const DraftCV = require("../models/DraftCV");
const { ARIA_CALL_MAX_SESSION_SEC } = require("../config/catalog");
const ariaLive = require("../services/ariaLive.service");
const { normalizeCallSettings } = require("../config/ariaCallSettings");

// Sections that can be built by voice. Education, skills and the summary are short factual
// fields where typing is faster than talking — offering a call there would spend minutes to
// make the user slower.
const VOICE_SECTIONS = new Set(["experience", "project"]);

// How long past its reserved length a reservation may linger before we treat it as dead.
// Covers the gap between the browser deciding the call is over and it telling us.
const STALE_GRACE_SEC = 60;

/**
 * Settle a reservation. Idempotent and safe to call from either the sideband or the client.
 *
 * Guarded on the reservationId so a double-settle writes nothing: whichever call lands
 * second matches no document and returns modifiedCount 0.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.reservationId
 * @param {number} opts.usedSec  seconds actually consumed (clamped to the reservation)
 * @returns {Promise<boolean>} whether THIS call was the one that settled it
 */
const settleReservation = async ({ userId, reservationId, usedSec }) => {
  const user = await UserModel.findById(userId).select("ariaCall").lean();
  const ar = user?.ariaCall?.activeReservation;
  if (!ar?.reservationId || ar.reservationId !== reservationId) return false;

  const reservedSec = Math.max(0, Number(ar.reservedSec) || 0);
  // The clamp is the trust boundary: a reported duration can only ever REDUCE what was
  // already debited, never extend it into minutes the user has not got.
  const used = Math.min(Math.max(0, Math.round(Number(usedSec) || 0)), reservedSec);
  const refund = reservedSec - used;

  // Paid minutes are the only bucket. A reservation in any other mode can only be a free-taste
  // call started before the taste was removed; it settles, but nothing is refunded into a
  // balance that no longer exists.
  const refundInc = ar.mode === "paid" ? { "ariaCall.secondsRemaining": refund } : null;

  const settled = await UserModel.updateOne(
    { _id: userId, "ariaCall.activeReservation.reservationId": reservationId },
    {
      ...(refund > 0 && refundInc ? { $inc: refundInc } : {}),
      $set: {
        "ariaCall.activeReservation": {
          reservationId: null,
          reservedSec: 0,
          startedAt: null,
          mode: null,
          sessionId: null,
        },
      },
    }
  );
  if (settled.modifiedCount === 0) return false;

  // Zero-amount usage row, exactly as the interview does: minutes are not credits, so this
  // records that time was spent without touching the credit ledger the admin charts read.
  try {
    await Transaction.create({
      userId,
      amount: 0,
      type: "usage",
      description: `Aria call ${used}s`,
      status: "completed",
    });
  } catch (err) {
    console.error("[AriaLive] usage transaction failed", err?.message);
  }
  return true;
};

// @desc    Mint a GPT-Live session for a build call and reserve its minutes
// @route   POST /api/aria-live/session
// @access  Private
exports.createAriaLiveSession = async (req, res) => {
  try {
    const { section, draftId, lang, callSettings } = req.body || {};
    // Sent by the client with each call, so a change made seconds before pressing the button
    // applies to THIS call without waiting on the profile save. Normalised to the allow-list:
    // nothing unlisted reaches the prompt or OpenAI.
    const settings = normalizeCallSettings(callSettings);
    if (!VOICE_SECTIONS.has(section)) {
      return res
        .status(400)
        .json({ message: "Calls are only available for roles and projects.", code: "NO_VOICE" });
    }

    const user = req.user;
    const ac = user.ariaCall || {};

    // An open reservation usually means a call is genuinely live, and minting a second would
    // debit twice for one conversation. But it can also mean a call that CRASHED — the tab
    // closed, the laptop slept, the server restarted and lost its settle timer — and a flat
    // 409 there locks the user out of the feature permanently with no way back.
    //
    // So: sweep it if it is older than it could possibly still be running, then carry on.
    // This is the restart-proof half of settlement; the timer below is the fast half.
    const open = ac.activeReservation;
    if (open?.reservationId) {
      const ageSec = open.startedAt
        ? (Date.now() - new Date(open.startedAt).getTime()) / 1000
        : Infinity;
      const expiredAfter = (Number(open.reservedSec) || 0) + STALE_GRACE_SEC;
      if (ageSec < expiredAfter) {
        return res
          .status(409)
          .json({ message: "A call is already in progress.", code: "CALL_IN_PROGRESS" });
      }
      // Charged in full: we never heard how long it ran, and a call we cannot account for
      // must not be free. The clamp in settleReservation makes this the maximum, not a guess.
      await settleReservation({
        userId: user._id,
        reservationId: open.reservationId,
        usedSec: open.reservedSec,
      });
    }

    // Purchased minutes only. There is no free taste on Aria calls — anyone who wants to talk
    // to Aria buys minutes first — so a zero balance is simply the out-of-minutes boundary.
    const avail = Math.max(0, Number(ac.secondsRemaining) || 0);
    if (avail <= 0) {
      return res.status(402).json({
        message: "You are out of Aria call minutes.",
        code: "NO_ARIA_MINUTES",
      });
    }

    const envCap = Number(process.env.ARIA_LIVE_MAX_SESSION_SEC) || ARIA_CALL_MAX_SESSION_SEC;
    const reservedSec = Math.max(1, Math.min(ARIA_CALL_MAX_SESSION_SEC, envCap, avail));
    const reservationId = crypto.randomUUID();
    const startedAt = new Date();

    const reserveQuery = { _id: user._id, "ariaCall.secondsRemaining": { $gte: reservedSec } };
    const reserveUpdate = {
      $inc: { "ariaCall.secondsRemaining": -reservedSec },
      $set: {
        "ariaCall.activeReservation": {
          reservationId,
          reservedSec,
          startedAt,
          mode: "paid",
          sessionId: null,
        },
      },
    };

    const reserved = await UserModel.updateOne(reserveQuery, reserveUpdate);
    if (reserved.modifiedCount === 0) {
      return res
        .status(402)
        .json({ message: "Could not reserve Aria call minutes.", code: "NO_ARIA_MINUTES" });
    }

    // Everything the call's prompt needs, read from what is ALREADY on the draft.
    //
    // Deliberately no resolveDraftBrief here: that can trigger an AI rebuild, and this is the
    // path a user waits on with their finger on a call button. targetJob.brief is persisted
    // and hash-cached by the capture step, so it is already there whenever there is a target
    // job at all — and when there isn't, the requirement block simply doesn't render.
    let entryTitle = "";
    let entryType = "";
    let careerStage = "";
    let brief = null;
    try {
      if (draftId) {
        const draft = await DraftCV.findOne({ _id: draftId, userId: user._id })
          .select("experience projects careerStage targetJob.brief")
          .lean();
        const list = section === "project" ? draft?.projects : draft?.experience;
        const entry = Array.isArray(list) ? list[list.length - 1] : null;
        entryTitle = String(entry?.title || entry?.name || "").slice(0, 80);
        entryType = String(entry?.entryType || "");
        careerStage = String(draft?.careerStage || "");
        brief = draft?.targetJob?.brief || null;
      }
    } catch (err) {
      console.error("[AriaLive] draft lookup failed", err?.message);
    }

    let session = null;
    try {
      session = await ariaLive.mintAriaLiveSession({
        instructions: ariaLive.buildAriaLiveInstructions({
          section,
          entryTitle,
          entryType,
          careerStage,
          brief,
          lang,
          depth: settings.depth,
          style: settings.style,
        }),
        maxSessionSec: reservedSec,
        voice: settings.voice,
        pace: settings.pace,
      });
    } catch (err) {
      // Refund the whole reservation: the call never started, so none of it was used.
      await UserModel.updateOne(
        { _id: user._id, "ariaCall.activeReservation.reservationId": reservationId },
        {
          $inc: { "ariaCall.secondsRemaining": reservedSec },
          $set: {
            "ariaCall.activeReservation": {
              reservationId: null,
              reservedSec: 0,
              startedAt: null,
              mode: null,
              sessionId: null,
            },
          },
        }
      );
      const unavailable = err?.code === "ARIA_LIVE_UNAVAILABLE";
      console.error("[AriaLive] mint failed", err?.response?.data || err?.message);
      return res.status(unavailable ? 503 : 502).json({
        message: unavailable
          ? "Aria calls are not available right now."
          : "Could not start the call. You have not been charged.",
        code: unavailable ? "ARIA_LIVE_UNAVAILABLE" : "ARIA_LIVE_FAILED",
      });
    }

    // THE SETTLE TIMER. The client normally settles when it hangs up; this is what happens
    // when it doesn't — a closed tab, a dead battery, a lost connection. Charging the full
    // reservation is correct rather than harsh: we genuinely do not know how long the call
    // ran, and settleReservation's clamp means this is the ceiling the user already paid.
    //
    // In-process, so a server restart loses it — which is exactly what the stale sweep above
    // is for. The two together cover both failure shapes.
    const settleAt = (reservedSec + STALE_GRACE_SEC) * 1000;
    setTimeout(() => {
      settleReservation({ userId: user._id, reservationId, usedSec: reservedSec }).catch((err) =>
        console.error("[AriaLive] timed settle failed", err?.message)
      );
    }, settleAt).unref?.();

    return res.json({
      clientSecret: session.clientSecret,
      expiresAt: session.expiresAt,
      reservationId,
      reservedSec,
      mode: "paid",
      model: session.model,
      voice: session.voice,
    });
  } catch (error) {
    console.error("[AriaLive] createAriaLiveSession error", error);
    return res.status(500).json({ message: "Could not start the call." });
  }
};

// @desc    Settle a finished call immediately (the sideband would do it anyway)
// @route   POST /api/aria-live/end
// @access  Private
exports.endAriaLiveSession = async (req, res) => {
  try {
    const { reservationId, durationSec } = req.body || {};
    if (!reservationId) {
      return res.status(400).json({ message: "reservationId is required." });
    }
    const settled = await settleReservation({
      userId: req.user._id,
      reservationId,
      usedSec: durationSec,
    });
    // Not an error when it returns false: the sideband very likely got there first, which
    // is the system working. The client only needs the fresh balance either way.
    const fresh = await UserModel.findById(req.user._id).select("ariaCall").lean();
    return res.json({
      settled,
      secondsRemaining: fresh?.ariaCall?.secondsRemaining || 0,
    });
  } catch (error) {
    console.error("[AriaLive] endAriaLiveSession error", error);
    return res.status(500).json({ message: "Could not end the call cleanly." });
  }
};

exports.settleReservation = settleReservation;
exports.VOICE_SECTIONS = VOICE_SECTIONS;
