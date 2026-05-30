const User = require("../models/User");
const Resume = require("../models/Resume");
const Application = require("../models/Application");
const DraftCV = require("../models/DraftCV");
const Transaction = require("../models/Transaction");
const AICallLog = require("../models/AICallLog");
const DownloadLog = require("../models/DownloadLog");
const Feedback = require("../models/Feedback");
const Notification = require("../models/Notification");
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
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateFields },
      { new: true }
    ).select("-password");

    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Server Error");
  }
};

exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    res.json(user);
  } catch (err) {
    console.error(err.message);
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
