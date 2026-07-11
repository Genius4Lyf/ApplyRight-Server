const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Resume = require("../models/Resume");
const Application = require("../models/Application");
const DraftCV = require("../models/DraftCV");
const Transaction = require("../models/Transaction");
const Payment = require("../models/Payment");
const AICallLog = require("../models/AICallLog");
const DownloadLog = require("../models/DownloadLog");
const Feedback = require("../models/Feedback");
const Notification = require("../models/Notification");
const SettingsService = require("../services/settings.service");
const subscription = require("../services/subscription.service");

// Return a plain user object with the client-facing `plan` replaced by the
// EFFECTIVE (expiry-aware) paid status — so an expired subscriber isn't treated
// as paid by the CV-builder / profile gates that read user.plan. The raw stored
// User.plan field in the DB is unchanged.
const withEffectivePlan = (userDoc) => {
  const obj = typeof userDoc.toObject === "function" ? userDoc.toObject() : { ...userDoc };
  obj.plan = subscription.hasPaidAccess(userDoc) ? "paid" : "free";
  return obj;
};
const logger = require("../utils/logger");

exports.updateProfile = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      otherName,
      phone,
      linkedinUrl,
      portfolioUrl,
      currentJobTitle,
      currentStatus,
      education,
      careerGoals,
      skills,
      onboardingCompleted,
      settings,
    } = req.body;

    // Build update object
    const updateFields = {};
    if (firstName) updateFields.firstName = firstName;
    if (lastName) updateFields.lastName = lastName;
    if (otherName !== undefined) updateFields.otherName = otherName;
    if (phone !== undefined) updateFields.phone = phone;
    if (linkedinUrl !== undefined) updateFields.linkedinUrl = linkedinUrl;
    if (portfolioUrl !== undefined) updateFields.portfolioUrl = portfolioUrl;
    if (currentJobTitle !== undefined) updateFields.currentJobTitle = currentJobTitle;
    if (currentStatus) updateFields.currentStatus = currentStatus;
    if (education) updateFields.education = education;
    if (careerGoals) updateFields.careerGoals = careerGoals;
    if (skills) updateFields.skills = skills;
    if (typeof onboardingCompleted !== "undefined")
      updateFields.onboardingCompleted = onboardingCompleted;

    // Handle nested settings using dot notation to avoid overwriting other settings
    if (settings) {
      if (settings.showOnboardingTutorials !== undefined) {
        updateFields["settings.showOnboardingTutorials"] = settings.showOnboardingTutorials;
      }
      if (settings.autoGenerateAnalysis !== undefined) {
        updateFields["settings.autoGenerateAnalysis"] = settings.autoGenerateAnalysis;
      }
      if (settings.hideSkillsAiPrompt !== undefined) {
        updateFields["settings.hideSkillsAiPrompt"] = settings.hideSkillsAiPrompt;
      }
      // Notification preferences — whitelist each key so a client can't write
      // arbitrary fields into the settings subdoc.
      if (settings.notifications && typeof settings.notifications === "object") {
        for (const key of [
          "productUpdates",
          "interviewReminders",
          "applicationNudges",
          "marketingEmails",
        ]) {
          if (settings.notifications[key] !== undefined) {
            updateFields[`settings.notifications.${key}`] = !!settings.notifications[key];
          }
        }
      }
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateFields },
      { new: true }
    ).select("-password");

    res.json(withEffectivePlan(user));
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
};

exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(withEffectivePlan(user));
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
};

// @desc    Activity & progress snapshot for the Account hub Overview
// @route   GET /api/users/me/stats
// @access  Private
exports.getActivityStats = async (req, res) => {
  try {
    const userId = req.user.id;

    // CVs come from DraftCV; everything else is derived from Applications. Per-user
    // doc counts are modest, so we fetch the slim fields and reduce in JS rather
    // than hand-roll a deep aggregation over the nested interviewPrep subdoc.
    const [cvsCreated, apps] = await Promise.all([
      DraftCV.countDocuments({ userId }),
      Application.find({ userId })
        .select(
          "fitScore optimizedFitScore createdAt updatedAt " +
            "interviewPrep.interviewHistory interviewPrep.lastInterviewSession interviewPrep.rounds"
        )
        .sort({ createdAt: 1 })
        .lean(),
    ]);

    const fitScores = [];
    const fitTrend = [];
    let interviewsPracticed = 0;
    let bestInterviewScore = null;
    let lastActivityAt = null;

    for (const a of apps) {
      // Effective fit = the optimized score if the CV was generated, else the base.
      const eff =
        typeof a.optimizedFitScore === "number"
          ? a.optimizedFitScore
          : typeof a.fitScore === "number"
            ? a.fitScore
            : null;
      if (eff !== null) {
        fitScores.push(eff);
        fitTrend.push({ date: a.createdAt, score: eff });
      }

      const ip = a.interviewPrep || {};
      const history = Array.isArray(ip.interviewHistory) ? ip.interviewHistory : [];
      interviewsPracticed += history.length;

      // Best interview score across every signal we keep (history, loop rounds,
      // last session).
      const scores = [];
      history.forEach((h) => typeof h.score === "number" && scores.push(h.score));
      (Array.isArray(ip.rounds) ? ip.rounds : []).forEach(
        (r) => typeof r.score === "number" && scores.push(r.score)
      );
      if (ip.lastInterviewSession && typeof ip.lastInterviewSession.score === "number") {
        scores.push(ip.lastInterviewSession.score);
      }
      if (scores.length) {
        const localBest = Math.max(...scores);
        bestInterviewScore = bestInterviewScore === null ? localBest : Math.max(bestInterviewScore, localBest);
      }

      const t = a.updatedAt || a.createdAt;
      if (t && (!lastActivityAt || new Date(t) > new Date(lastActivityAt))) lastActivityAt = t;
    }

    const avgFitScore = fitScores.length
      ? Math.round(fitScores.reduce((s, n) => s + n, 0) / fitScores.length)
      : null;
    const bestFitScore = fitScores.length ? Math.max(...fitScores) : null;

    res.json({
      cvsCreated,
      applicationsAnalyzed: apps.length,
      interviewsPracticed,
      avgFitScore,
      bestFitScore,
      bestInterviewScore,
      lastActivityAt,
      // Chronological fit-score points for a sparkline (last 12).
      fitTrend: fitTrend.slice(-12),
    });
  } catch (err) {
    console.error("getActivityStats error:", err.message);
    res.status(500).send("Server Error");
  }
};

// @desc    Referral stats for the Account hub (code, invites, credits earned)
// @route   GET /api/users/me/referrals
// @access  Private
exports.getReferralStats = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("referralCode referralCount");
    if (!user) return res.status(404).json({ message: "User not found" });

    // Per-invite bonus (also used for the "earn N per friend" copy on the card).
    let referralBonus = 0;
    try {
      const settings = await SettingsService.getSettings();
      referralBonus = settings?.credits?.referralBonus || 0;
    } catch (e) {
      logger.warn(`getReferralStats: settings unavailable (${e.message})`);
    }

    // Credits actually earned from referrals. Referral bonuses are logged as
    // type "streak_bonus" with a "Referral Bonus" description (see auth.controller),
    // so we match on description rather than type (which is shared with ad streaks).
    const earnedAgg = await Transaction.aggregate([
      {
        $match: {
          userId: user._id,
          type: "streak_bonus",
          status: "completed",
          description: { $regex: /^Referral Bonus/ },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const creditsEarned = earnedAgg[0]?.total || 0;

    res.json({
      referralCode: user.referralCode || null,
      referralCount: user.referralCount || 0,
      creditsEarned,
      referralBonus,
    });
  } catch (err) {
    console.error("getReferralStats error:", err.message);
    res.status(500).send("Server Error");
  }
};

// @desc    Change account email (requires current password)
// @route   PATCH /api/users/me/email
// @access  Private
exports.changeEmail = async (req, res) => {
  try {
    const { currentPassword, newEmail } = req.body || {};
    if (!currentPassword || !newEmail) {
      return res.status(400).json({ message: "Current password and new email are required." });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(401).json({ message: "Password is incorrect.", code: "BAD_PASSWORD" });
    }

    const normalized = String(newEmail).toLowerCase().trim();
    if (normalized === user.email) {
      return res.status(400).json({ message: "That's already your email address." });
    }

    user.email = normalized;
    await user.save(); // runs the schema email validator + uniqueness

    const safe = user.toObject();
    delete safe.password;
    delete safe.resetPasswordToken;
    delete safe.resetPasswordExpire;
    // Client-facing EFFECTIVE (expiry-aware) paid status; raw DB field unchanged.
    safe.plan = subscription.hasPaidAccess(user) ? "paid" : "free";
    res.json(safe);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "That email is already in use.", code: "EMAIL_TAKEN" });
    }
    if (err.name === "ValidationError") {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }
    console.error("changeEmail error:", err.message);
    res.status(500).send("Server Error");
  }
};

// @desc    Change account password (requires current password)
// @route   PATCH /api/users/me/password
// @access  Private
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required." });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters." });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(401).json({ message: "Current password is incorrect.", code: "BAD_PASSWORD" });
    }

    const same = await bcrypt.compare(newPassword, user.password);
    if (same) {
      return res.status(400).json({ message: "New password must be different from the current one." });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    res.json({ message: "Password updated successfully." });
  } catch (err) {
    console.error("changePassword error:", err.message);
    res.status(500).send("Server Error");
  }
};

// @desc    Export all of the user's data as a downloadable JSON file
// @route   GET /api/users/me/export
// @access  Private
exports.exportData = async (req, res) => {
  try {
    const userId = req.user.id;
    const [account, resumes, applications, cvs, transactions, payments] = await Promise.all([
      User.findById(userId).select("-password -resetPasswordToken -resetPasswordExpire").lean(),
      Resume.find({ userId }).lean(),
      Application.find({ userId }).lean(),
      DraftCV.find({ userId }).lean(),
      Transaction.find({ userId }).lean(),
      Payment.find({ userId }).lean(),
    ]);

    if (!account) return res.status(404).json({ message: "User not found" });

    const payload = {
      exportedAt: new Date().toISOString(),
      account,
      resumes,
      applications,
      cvs,
      transactions,
      payments,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="applyright-data-${userId}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("exportData error:", err.message);
    res.status(500).send("Server Error");
  }
};

exports.deleteProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    logger.info(`Starting account deletion for user: ${userId}`);

    // Cascade delete all associated data
    const resumeResult = await Resume.deleteMany({ userId });
    const appResult = await Application.deleteMany({ userId });
    const cvResult = await DraftCV.deleteMany({ userId });
    const txResult = await Transaction.deleteMany({ userId });
    const aiLogResult = await AICallLog.deleteMany({ userId });
    const downloadLogResult = await DownloadLog.deleteMany({ userId });
    const feedbackResult = await Feedback.deleteMany({ user: userId });
    const notificationResult = await Notification.deleteMany({ userId });

    logger.info(
      `Purged user data for ${userId}: resumes=${resumeResult.deletedCount}, applications=${appResult.deletedCount}, cvs=${cvResult.deletedCount}, transactions=${txResult.deletedCount}, aiLogs=${aiLogResult.deletedCount}, downloadLogs=${downloadLogResult.deletedCount}, feedback=${feedbackResult.deletedCount}, notifications=${notificationResult.deletedCount}`
    );

    // Delete the user itself
    const deletedUser = await User.findByIdAndDelete(userId);
    if (!deletedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "Account and all associated data deleted successfully." });
  } catch (err) {
    logger.error(`Account deletion error for ${userId}: ${err.message}\n${err.stack}`);
    res.status(500).send("Server Error");
  }
};
