const User = require("../models/User");
const Transaction = require("../models/Transaction");
const env = require("../config/env");
const logger = require("../utils/logger");

const startOfUtcDay = (now) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const updateStreak = (user, now) => {
  const todayUtc = startOfUtcDay(now);
  const yesterdayUtc = new Date(todayUtc.getTime() - 24 * 60 * 60 * 1000);

  if (!user.adStreak) {
    user.adStreak = { current: 0, longest: 0, lastWatchDate: null };
  }

  const lastWatchDate = user.adStreak.lastWatchDate
    ? startOfUtcDay(new Date(user.adStreak.lastWatchDate))
    : null;

  let incremented = false;
  if (lastWatchDate && lastWatchDate.getTime() === todayUtc.getTime()) {
    // Already counted today
  } else if (lastWatchDate && lastWatchDate.getTime() === yesterdayUtc.getTime()) {
    user.adStreak.current += 1;
    incremented = true;
  } else {
    user.adStreak.current = 1;
    incremented = true;
  }

  if (user.adStreak.current > user.adStreak.longest) {
    user.adStreak.longest = user.adStreak.current;
  }
  user.adStreak.lastWatchDate = now;

  let bonus = 0;
  let message = "";
  if (incremented) {
    if (user.adStreak.current === 3) {
      bonus = 5;
      message = "🔥 3-Day Streak Bonus!";
    } else if (user.adStreak.current === 7) {
      bonus = 15;
      message = "🔥 7-Day Streak Bonus!";
    }
  }

  return { bonus, message };
};

/**
 * Award credits for a watched ad, enforcing a per-user cooldown and a daily
 * cap. Both web (Monetag) and native Android (AdMob) flow through here.
 *
 * @param {object} user — Mongoose User document
 * @param {object} opts
 * @param {"monetag"|"admob"} opts.source
 * @param {number} opts.amount — base credit reward
 * @param {string|null} [opts.externalTxId] — AdMob SSV transaction_id
 * @returns {Promise<{ok:boolean, code?:string, retryAfterMs?:number, credits?:number, added?:number, streak?:number, streakBonus?:number, streakMessage?:string}>}
 */
exports.awardAdCredits = async (user, { source, amount, externalTxId = null }) => {
  const now = new Date();
  const todayUtc = startOfUtcDay(now);
  const cooldownMs = env.ADMOB_COOLDOWN_SECONDS * 1000;
  const dailyCap = env.ADMOB_DAILY_CAP;

  if (!user.adWatch) {
    user.adWatch = { lastAt: null, todayCount: 0, todayDate: null };
  }

  // Daily counter reset at UTC midnight
  const todayDate = user.adWatch.todayDate ? new Date(user.adWatch.todayDate) : null;
  if (!todayDate || todayDate.getTime() < todayUtc.getTime()) {
    user.adWatch.todayCount = 0;
    user.adWatch.todayDate = todayUtc;
  }

  // Cooldown
  if (user.adWatch.lastAt) {
    const elapsed = now.getTime() - new Date(user.adWatch.lastAt).getTime();
    if (elapsed < cooldownMs) {
      const retryAfterMs = cooldownMs - elapsed;
      await Transaction.create({
        userId: user._id,
        amount: 0,
        type: "ad_reward",
        description: `Rejected (cooldown) — ${source}`,
        status: "failed",
        rejectedReason: "cooldown",
        externalTxId,
      }).catch((err) => {
        // Duplicate externalTxId or other write error — ok to swallow for telemetry
        logger.warn(`adReward cooldown audit write failed: ${err.message}`);
      });
      return { ok: false, code: "COOLDOWN", retryAfterMs };
    }
  }

  // Daily cap
  if (user.adWatch.todayCount >= dailyCap) {
    await Transaction.create({
      userId: user._id,
      amount: 0,
      type: "ad_reward",
      description: `Rejected (daily cap) — ${source}`,
      status: "failed",
      rejectedReason: "daily_cap",
      externalTxId,
    }).catch((err) => {
      logger.warn(`adReward cap audit write failed: ${err.message}`);
    });
    return { ok: false, code: "DAILY_CAP" };
  }

  // Streak — AdMob only (real video views), Monetag stays excluded
  let streakBonus = 0;
  let streakMessage = "";
  if (source === "admob") {
    const streak = updateStreak(user, now);
    streakBonus = streak.bonus;
    streakMessage = streak.message;
  }

  const totalReward = amount + streakBonus;

  user.credits += totalReward;
  user.adWatch.lastAt = now;
  user.adWatch.todayCount += 1;
  user.adWatch.todayDate = todayUtc;

  await user.save({ validateBeforeSave: false });

  await Transaction.create({
    userId: user._id,
    amount,
    type: "ad_reward",
    description:
      source === "admob" ? "AdMob Rewarded Video" : "Watched Sponsored Offer",
    status: "completed",
    externalTxId,
  });

  if (streakBonus > 0) {
    await Transaction.create({
      userId: user._id,
      amount: streakBonus,
      type: "streak_bonus",
      description: streakMessage,
      status: "completed",
    });
  }

  return {
    ok: true,
    credits: user.credits,
    added: totalReward,
    streak: user.adStreak ? user.adStreak.current : 0,
    streakBonus,
    streakMessage,
  };
};
