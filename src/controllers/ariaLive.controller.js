// Aria Live — session minting and minute accounting for the spoken CV build.
//
// The money shape is lifted from interviewPrep.controller's reserve-then-reconcile, because
// it is correct and battle-tested: debit up front under a guarded update so a race loses
// cleanly, record WHICH bucket was debited, and settle against real usage at the end. Two
// things are deliberately different, and both are improvements the interview can't make:
//
//   1. SETTLEMENT IS NOT THE CLIENT'S JOB. The server minted the session, so it holds a
//      sideband and settles from OpenAI's own usage.seconds when the call closes. The
//      interview reconciles against a duration the CLIENT reports, and if the client never
//      calls assess-interview the reservation simply stays open and fully debited.
//
//   2. THE HARD STOP IS REAL. attachSideband hangs up at the cap. The interview's cap is a
//      countdown in the browser.
//
// The client-facing end endpoint still exists, because a user who hangs up should see their
// balance settle immediately rather than a second later. It is an optimisation over the
// sideband, not the source of truth — both routes run through the same idempotent settle.
const crypto = require("crypto");
const UserModel = require("../models/User");
const Transaction = require("../models/Transaction");
const DraftCV = require("../models/DraftCV");
const { ARIA_CALL_FREE_TASTE_SEC, ARIA_CALL_MAX_SESSION_SEC } = require("../config/catalog");
const ariaLive = require("../services/ariaLive.service");

// Sections that can be built by voice. Education, skills and the summary are short factual
// fields where typing is faster than talking — offering a call there would spend minutes to
// make the user slower.
const VOICE_SECTIONS = new Set(["experience", "project"]);

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

  const refundInc =
    ar.mode === "free"
      ? { "ariaCall.freeTasteUsedSec": -refund }
      : { "ariaCall.secondsRemaining": refund };

  const settled = await UserModel.updateOne(
    { _id: userId, "ariaCall.activeReservation.reservationId": reservationId },
    {
      ...(refund > 0 ? { $inc: refundInc } : {}),
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
    const { sdp, section, draftId, lang } = req.body || {};
    if (!sdp || typeof sdp !== "string") {
      return res.status(400).json({ message: "An SDP offer is required.", code: "NO_SDP" });
    }
    if (!VOICE_SECTIONS.has(section)) {
      return res
        .status(400)
        .json({ message: "Calls are only available for roles and projects.", code: "NO_VOICE" });
    }

    const user = req.user;
    const ac = user.ariaCall || {};

    // An open reservation means a call is already live (or one crashed without settling).
    // Minting a second would debit twice for one conversation.
    if (ac.activeReservation?.reservationId) {
      return res
        .status(409)
        .json({ message: "A call is already in progress.", code: "CALL_IN_PROGRESS" });
    }

    // Purchased seconds spend FIRST, and the taste only when there are none. The interview
    // learned this the hard way: picking the bucket by TIER meant a free-tier user could
    // never spend minutes they had actually bought.
    const paidAvail = Math.max(0, Number(ac.secondsRemaining) || 0);
    const freeAvail = Math.max(0, ARIA_CALL_FREE_TASTE_SEC - (Number(ac.freeTasteUsedSec) || 0));
    const useFreeTaste = paidAvail <= 0;
    const avail = useFreeTaste ? freeAvail : paidAvail;
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

    const reserveQuery = useFreeTaste
      ? {
          _id: user._id,
          "ariaCall.freeTasteUsedSec": { $lte: ARIA_CALL_FREE_TASTE_SEC - reservedSec },
        }
      : { _id: user._id, "ariaCall.secondsRemaining": { $gte: reservedSec } };
    const reserveUpdate = {
      $inc: useFreeTaste
        ? { "ariaCall.freeTasteUsedSec": reservedSec }
        : { "ariaCall.secondsRemaining": -reservedSec },
      $set: {
        "ariaCall.activeReservation": {
          reservationId,
          reservedSec,
          startedAt,
          mode: useFreeTaste ? "free" : "paid",
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

    // Name the thing being built so Aria opens with it instead of "tell me about this role".
    // Best-effort: a failed lookup costs a nicer opening line, never the call.
    let entryTitle = "";
    try {
      if (draftId) {
        const draft = await DraftCV.findOne({ _id: draftId, userId: user._id })
          .select("experience projects")
          .lean();
        const list = section === "project" ? draft?.projects : draft?.experience;
        const entry = Array.isArray(list) ? list[list.length - 1] : null;
        entryTitle = String(entry?.title || entry?.name || "").slice(0, 80);
      }
    } catch (err) {
      console.error("[AriaLive] entry lookup failed", err?.message);
    }

    let session = null;
    try {
      session = await ariaLive.mintAriaLiveSession({
        sdp,
        instructions: ariaLive.buildAriaLiveInstructions({ section, entryTitle, lang }),
        maxSessionSec: reservedSec,
      });
    } catch (err) {
      // REFUND THE BUCKET WE DEBITED — not "the paid one". The interview has two older
      // refund sites that only ever credit secondsRemaining, so a free-taste session that
      // failed to mint silently consumed the taste. Keyed off useFreeTaste here.
      await UserModel.updateOne(
        { _id: user._id, "ariaCall.activeReservation.reservationId": reservationId },
        {
          $inc: useFreeTaste
            ? { "ariaCall.freeTasteUsedSec": -reservedSec }
            : { "ariaCall.secondsRemaining": reservedSec },
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

    await UserModel.updateOne(
      { _id: user._id, "ariaCall.activeReservation.reservationId": reservationId },
      { $set: { "ariaCall.activeReservation.sessionId": session.sessionId } }
    );

    // The server's grip on the call: hangs up at the cap, and settles from OpenAI's own
    // usage.seconds. Fire-and-forget by design — it outlives this request.
    ariaLive.attachSideband({
      sessionId: session.sessionId,
      maxSessionSec: reservedSec,
      onClosed: ({ usedSec }) => {
        settleReservation({ userId: user._id, reservationId, usedSec }).catch((err) =>
          console.error("[AriaLive] settle failed", err?.message)
        );
      },
    });

    return res.json({
      sessionId: session.sessionId,
      sdp: session.sdp,
      reservationId,
      reservedSec,
      mode: useFreeTaste ? "free" : "paid",
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
      freeTasteRemainingSec: Math.max(
        0,
        ARIA_CALL_FREE_TASTE_SEC - (fresh?.ariaCall?.freeTasteUsedSec || 0)
      ),
    });
  } catch (error) {
    console.error("[AriaLive] endAriaLiveSession error", error);
    return res.status(500).json({ message: "Could not end the call cleanly." });
  }
};

exports.settleReservation = settleReservation;
exports.VOICE_SECTIONS = VOICE_SECTIONS;
