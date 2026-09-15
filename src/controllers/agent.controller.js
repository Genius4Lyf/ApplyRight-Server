const DraftCV = require("../models/DraftCV");
const DownloadLog = require("../models/DownloadLog");
const { CATALOG, getItem } = require("../config/catalog");
const { getEffectiveTier, availableCredits } = require("../services/subscription.service");

// All handlers assume `protect` + `agent` middleware ran, so req.user is the full
// agent user doc. Every query is scoped to req.user so an agent only sees their own.

const DAY_MS = 24 * 60 * 60 * 1000;

// @desc    Earnings/usage summary for the agent dashboard
// @route   GET /api/agent/summary?from=ISO&to=ISO
// @access  Private (agent)
//
// Downloads are counted from DownloadLog (written on every successful PDF export,
// agents included). Earnings/profit are derived on the client from `rateNgn` and
// `plan.amountNgn` so the ₦ display logic lives in one place.
const getSummary = async (req, res) => {
  try {
    const userId = req.user._id;
    const rateNgn = CATALOG.download_single?.amountNgn || 500;

    // Default range: the current billing period (or the last 30 days if none).
    const periodStart = req.user.subscription?.currentPeriodStart || null;
    const from = req.query.from
      ? new Date(req.query.from)
      : periodStart || new Date(Date.now() - 30 * DAY_MS);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    // Make `to` inclusive of the whole end day.
    const toInclusive = new Date(to.getTime());
    if (req.query.to) toInclusive.setHours(23, 59, 59, 999);

    const [cvCount, allTime, rangeCount, byDayRaw] = await Promise.all([
      DraftCV.countDocuments({ userId }),
      DownloadLog.countDocuments({ userId }),
      DownloadLog.countDocuments({ userId, createdAt: { $gte: from, $lte: toInclusive } }),
      DownloadLog.aggregate([
        { $match: { userId, createdAt: { $gte: from, $lte: toInclusive } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const item = getItem(req.user.subscription?.planId);
    const active = getEffectiveTier(req.user) !== "free";

    res.json({
      cvCount,
      rateNgn,
      downloads: { allTime, range: rangeCount },
      byDay: byDayRaw.map((d) => ({ date: d._id, count: d.count })),
      range: { from, to: toInclusive },
      // CV credits power tailoring (bullets/skills/cover letters); downloads are
      // free for active agents. `available` = plan allowance + persistent wallet.
      credits: {
        available: availableCredits(req.user),
        plan: active ? Math.max(0, req.user.subscription?.creditsRemaining || 0) : 0,
        wallet: Math.max(0, req.user.credits || 0),
      },
      plan: {
        active,
        planId: item?.id || null,
        label: item?.label || null,
        amountNgn: item?.amountNgn || 0,
        periodDays: item?.periodDays || 0,
        currentPeriodStart: periodStart,
        expiresAt: req.user.subscription?.expiresAt || null,
      },
    });
  } catch (error) {
    console.error("Agent Summary Error:", error);
    res.status(500).json({ message: "Failed to fetch summary" });
  }
};

module.exports = { getSummary };
