const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Resume = require("../models/Resume");
const Job = require("../models/Job");
const JobSearch = require("../models/JobSearch");
const screenshotService = require("../services/screenshot.service");
const Application = require("../models/Application");
const SettingsService = require("../services/settings.service");
const NotificationController = require("./notification.controller");

// @desc    Get dashboard stats
// @route   GET /api/v1/admin/stats
// @access  Private/Admin
exports.getDashboardStats = async (req, res, next) => {
  try {
    const period = req.query.period || "monthly"; // 'monthly' (default) or 'daily'
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1; // 1-12

    const totalUsers = await User.countDocuments({ role: { $ne: "admin" } });
    const totalResumes = await Resume.countDocuments();
    const totalApplications = await Application.countDocuments();

    // Calculate total credits (current pool)
    const creditsResult = await User.aggregate([
      { $match: { role: { $ne: "admin" } } },
      { $group: { _id: null, total: { $sum: "$credits" } } },
    ]);
    const totalCredits = creditsResult.length > 0 ? creditsResult[0].total : 0;

    // Calculate credits usage over time (Chart Data)
    let dateGroupFormat;
    let matchStage = {};

    if (period === "daily") {
      // View daily stats for a specific month and year
      // Note: Months in JS Date are 0-indexed (0=Jan), but we expect 1-12 from query
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59, 999); // Last day of month

      matchStage = {
        createdAt: { $gte: startDate, $lte: endDate },
      };
      dateGroupFormat = "%Y-%m-%d";
    } else {
      // View monthly stats for a specific year (Default)
      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59, 999);

      matchStage = {
        createdAt: { $gte: startDate, $lte: endDate },
      };
      dateGroupFormat = "%Y-%m"; // Groups by YYYY-MM
    }

    const chartStats = await Transaction.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { $dateToString: { format: dateGroupFormat, date: "$createdAt" } },
          credits: { $sum: "$amount" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Format chart data for frontend
    const chartData = chartStats.map((item) => ({
      name: item._id,
      credits: item.credits,
    }));

    // Get recent 5 users
    const recentUsers = await User.find().sort({ createdAt: -1 }).limit(5).select("-password");

    // Get recent 5 transactions
    const recentTransactions = await Transaction.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("userId", "firstName lastName email");

    // Calculate user growth (last 30 days)
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const newUsersLastMonth = await User.countDocuments({
      createdAt: { $gte: lastMonth },
      role: { $ne: "admin" },
    });

    // --- Feature Usage Stats ---

    // 1. Creation Method (Upload vs Scratch)
    // We look at DraftCVs. explicit 'source' field is best, but we fall back to title heuristic for older docs if needed.
    const allDrafts = await require("../models/DraftCV").find({}, "source title");

    let uploadCount = 0;
    let scratchCount = 0;

    allDrafts.forEach((draft) => {
      if (draft.source === "upload") {
        uploadCount++;
      } else if (draft.source === "scratch") {
        scratchCount++;
      } else if (draft.title === "Uploaded Resume") {
        uploadCount++; // Heuristic for older documents without 'source' field
      } else {
        scratchCount++; // Heuristic: if it's named anything else, it was likely typed
      }
    });

    // Add pure resume uploads to upload count
    uploadCount += totalResumes;

    const creationMethod = {
      upload: uploadCount,
      scratch: scratchCount,
      unknown: 0, // we've bucketed everything via heuristics
    };

    // 2. CV Generation (AI Optimizations & Downloads)
    // AI Optimizations = Total Applications (since every App is an optimization/analysis result)
    const totalOptimizations = await Application.countDocuments();

    // Lazy load DownloadLog if not imported at top
    const DownloadLog = require("../models/DownloadLog");

    // Downloads = Total count of DownloadLogs
    const totalDownloads = await DownloadLog.countDocuments();

    // 3. Analysis Usage (With Job Description)
    // An Application implies a Job ID exists (schema requires it). So totalApplications is effectively analysis usage.
    // But maybe we want to distinguish "Detailed Analysis" vs just "Saved".
    // Schema: jobId is required. So all Applications are analyses.

    // 4. Template Popularity (Based on Downloads)
    const ALL_TEMPLATES = require("../data/templates"); // Import master list

    const downloadStats = await DownloadLog.aggregate([
      { $group: { _id: "$templateId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Merge with master list to ensure ALL templates are shown, even with 0 downloads
    const templateStats = ALL_TEMPLATES.map((template) => {
      const found = downloadStats.find((stat) => stat._id === template.id);
      return {
        name: template.name,
        count: found ? found.count : 0,
      };
    });

    // Sort by count desc, then by name
    templateStats.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });

    // Fallback: If no download logs yet (migration period), maybe mix with application stats?
    // Or just show 0 until downloads happen. The user asked to track downloads specifically.

    // Note: totalApplications acts as "Total Analysis" count
    // totalDownloads should ideally count DownloadLogs too?
    // Currently totalDownloads is from Transactions.
    // Let's keep totalDownloads as is for now or use the count of DownloadLogs?
    // User asked for "Top Templates" to be tracked by download.

    const featureUsage = {
      creationMethod,
      cvGeneration: {
        optimizations: totalOptimizations,
        downloads: totalDownloads,
      },
      templatePopularity: templateStats, // Return FULL list
    };

    // --- Job Search Metrics ---
    const totalJobSearches = await JobSearch.countDocuments();

    const searchesBySource = await JobSearch.aggregate([
      { $group: { _id: "$source", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const topKeywords = await JobSearch.aggregate([
      { $match: { "query.keywords": { $exists: true, $nin: [null, ""] } } },
      { $group: { _id: "$query.keywords", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    const topLocations = await JobSearch.aggregate([
      { $match: { "query.location": { $exists: true, $nin: [null, ""] } } },
      { $group: { _id: "$query.location", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    const engagementStats = await JobSearch.aggregate([
      { $unwind: { path: "$results", preserveNullAndEmptyArrays: false } },
      {
        $group: {
          _id: null,
          totalClicks: { $sum: { $cond: [{ $eq: ["$results.clicked", true] }, 1, 0] } },
          totalSaved: { $sum: { $cond: [{ $eq: ["$results.saved", true] }, 1, 0] } }
        }
      }
    ]);

    const jobEngagement = engagementStats.length > 0 ? engagementStats[0] : { totalClicks: 0, totalSaved: 0 };

    // --- Conversion Funnel ---
    const totalTailors = await Transaction.countDocuments({ type: "cv_tailor" });
    const totalBundles = await Transaction.countDocuments({ type: "tailor_bundle" });

    const jobMetrics = {
      totalSearches: totalJobSearches,
      engagement: jobEngagement,
      searchesBySource,
      topKeywords,
      topLocations,
      funnel: {
        searches: totalJobSearches,
        clicks: jobEngagement.totalClicks,
        saves: jobEngagement.totalSaved,
        tailors: totalTailors + totalBundles,
        applications: totalApplications,
      },
    };

    res.status(200).json({
      success: true,
      data: {
        totalUsers,
        totalCredits,
        totalResumes,
        totalApplications,
        newUsersLastMonth,
        recentUsers,
        recentTransactions,
        chartData,
        featureUsage, // NEW
        jobMetrics, // NEW: Job Search analytics
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Revenue & subscription analytics (real NGN, from the Payment model)
// @route   GET /api/v1/admin/revenue
// @access  Private/Admin
//
// Kept separate from getDashboardStats: that one aggregates Transaction.amount as
// CREDITS. Money lives in Payment, so revenue reads from there and never pollutes
// the credit charts.
exports.getRevenueStats = async (req, res) => {
  try {
    const Payment = require("../models/Payment");
    const { CATALOG, EST_COST_NGN_PER_MIN } = require("../config/catalog");

    const period = req.query.period || "monthly"; // 'monthly' | 'daily'
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;

    let dateGroupFormat;
    let startDate;
    let endDate;
    if (period === "daily") {
      startDate = new Date(year, month - 1, 1);
      endDate = new Date(year, month, 0, 23, 59, 59, 999);
      dateGroupFormat = "%Y-%m-%d";
    } else {
      startDate = new Date(year, 0, 1);
      endDate = new Date(year, 11, 31, 23, 59, 59, 999);
      dateGroupFormat = "%Y-%m";
    }

    // Only successful payments count as revenue. Use grantedAt where present so
    // the chart reflects when money was actually recognized.
    const successMatch = { status: "successful" };

    // Revenue over time
    const revenueOverTimeRaw = await Payment.aggregate([
      { $match: { ...successMatch, createdAt: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: { $dateToString: { format: dateGroupFormat, date: "$createdAt" } },
          revenue: { $sum: "$amountNgn" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const revenueOverTime = revenueOverTimeRaw.map((r) => ({
      name: r._id,
      revenue: r.revenue,
      count: r.count,
    }));

    // Revenue by plan (all-time successful)
    const revenueByPlanRaw = await Payment.aggregate([
      { $match: successMatch },
      { $group: { _id: "$planId", revenue: { $sum: "$amountNgn" }, count: { $sum: 1 } } },
      { $sort: { revenue: -1 } },
    ]);
    const revenueByPlan = revenueByPlanRaw.map((r) => ({
      planId: r._id,
      label: CATALOG[r._id]?.label || r._id,
      revenue: r.revenue,
      count: r.count,
    }));

    // Totals
    const totalRevenue = revenueByPlan.reduce((s, r) => s + r.revenue, 0);
    const totalTopupRevenue = revenueByPlan
      .filter((r) => CATALOG[r.planId]?.purpose === "topup")
      .reduce((s, r) => s + r.revenue, 0);

    // Active subscriptions by tier (not expired)
    const now = new Date();
    const activeSubsRaw = await User.aggregate([
      { $match: { "subscription.expiresAt": { $gt: now } } },
      { $group: { _id: "$subscription.tier", count: { $sum: 1 } } },
    ]);
    const activeSubsByTier = activeSubsRaw.reduce(
      (acc, r) => ({ ...acc, [r._id || "free"]: r.count }),
      {}
    );
    const activeSubsTotal = activeSubsRaw.reduce((s, r) => s + r.count, 0);

    // New conversions in the selected window (first-time or any successful sub purchase)
    const newConversions = await Payment.countDocuments({
      status: "successful",
      purpose: "subscription",
      createdAt: { $gte: startDate, $lte: endDate },
    });

    // Live-interview minutes consumed in the window (from usage transactions we tag
    // "Live interview Ns (...)"). Sum the reported seconds for an est. OpenAI cost.
    const liveTxns = await Transaction.find({
      type: "usage",
      description: { $regex: /^Live interview \d+s/ },
      createdAt: { $gte: startDate, $lte: endDate },
    }).select("description");
    let liveSecondsFull = 0;
    let liveSecondsMini = 0;
    for (const t of liveTxns) {
      const m = /^Live interview (\d+)s \((\w+)\)/.exec(t.description || "");
      if (!m) continue;
      const sec = Number(m[1]) || 0;
      if (m[2] === "pro") liveSecondsFull += sec;
      else liveSecondsMini += sec;
    }
    const liveMinutesConsumed = Math.round((liveSecondsFull + liveSecondsMini) / 60);
    const estOpenAiCostNgn = Math.round(
      (liveSecondsMini / 60) * (EST_COST_NGN_PER_MIN.mini || 0) +
        (liveSecondsFull / 60) * (EST_COST_NGN_PER_MIN.full || 0)
    );

    // Most popular subscription plan, ranked by number of successful purchases
    // (all-time) — answers "which plan do users buy the most?".
    const planPopularityRaw = await Payment.aggregate([
      { $match: { status: "successful", purpose: "subscription" } },
      { $group: { _id: "$planId", count: { $sum: 1 }, revenue: { $sum: "$amountNgn" } } },
      { $sort: { count: -1 } },
    ]);
    const planPopularity = planPopularityRaw.map((r) => ({
      planId: r._id,
      label: CATALOG[r._id]?.label || r._id,
      count: r.count,
      revenue: r.revenue,
    }));
    const mostPopularPlan = planPopularity[0] || null;

    // Live-minute top-ups (users buying MORE interview time) — all-time successful.
    const topupAgg = await Payment.aggregate([
      { $match: { status: "successful", purpose: "topup" } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          revenue: { $sum: "$amountNgn" },
          minutes: { $sum: "$minutesGranted" },
          buyers: { $addToSet: "$userId" },
        },
      },
    ]);
    const topupStats = topupAgg.length
      ? {
          count: topupAgg[0].count,
          revenue: topupAgg[0].revenue,
          minutes: topupAgg[0].minutes,
          buyers: topupAgg[0].buyers.length,
        }
      : { count: 0, revenue: 0, minutes: 0, buyers: 0 };

    // Subscriptions expiring within the next 7 days (churn-watch / renewal nudge).
    const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const expiringSoon = await User.countDocuments({
      "subscription.expiresAt": { $gt: now, $lte: in7days },
    });

    res.status(200).json({
      success: true,
      data: {
        period,
        totalRevenue,
        totalTopupRevenue,
        revenueOverTime,
        revenueByPlan,
        planPopularity,
        mostPopularPlan,
        topupStats,
        expiringSoon,
        activeSubsByTier,
        activeSubsTotal,
        newConversions,
        liveMinutesConsumed,
        estOpenAiCostNgn,
        // Crude gross-margin guardrail for the window's recognized revenue.
        estGrossMarginPct:
          totalRevenue > 0
            ? Math.round(((totalRevenue - estOpenAiCostNgn) / totalRevenue) * 100)
            : null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Get all users
// @route   GET /api/v1/admin/users
// @access  Private/Admin
exports.getAllUsers = async (req, res, next) => {
  try {
    const pageSize = 10;
    // Accept both `page` and the older `pageNumber` the frontend used to send.
    const page = Number(req.query.page || req.query.pageNumber) || 1;
    const { keyword, plan, tier, status, sortBy, sortDir } = req.query;
    const now = new Date();

    // Build the filter. `$and` collects sub-clauses that each carry their own
    // `$or` (keyword search, free-status check) so they don't overwrite one another.
    const filter = {};
    const and = [];

    if (keyword) {
      and.push({
        $or: [
          { firstName: { $regex: keyword, $options: "i" } },
          { lastName: { $regex: keyword, $options: "i" } },
          { email: { $regex: keyword, $options: "i" } },
        ],
      });
    }

    // plan = lifetime template unlock (free/paid). tier = subscription tier.
    if (plan && ["free", "paid"].includes(plan)) filter.plan = plan;
    if (tier && ["free", "plus", "pro"].includes(tier)) filter["subscription.tier"] = tier;

    // status filters on the live subscription, using expiresAt as the source of truth.
    if (status === "active") {
      filter["subscription.expiresAt"] = { $gt: now };
    } else if (status === "free") {
      and.push({
        $or: [
          { "subscription.expiresAt": null },
          { "subscription.expiresAt": { $lte: now } },
        ],
      });
    }

    if (and.length) filter.$and = and;

    const dir = sortDir === "asc" ? 1 : -1;
    const sortMap = {
      joined: { createdAt: dir },
      credits: { credits: dir },
      expiry: { "subscription.expiresAt": dir },
    };
    const sort = sortMap[sortBy] || { createdAt: -1 };

    const count = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("-password")
      .sort(sort)
      .limit(pageSize)
      .skip(pageSize * (page - 1));

    res.status(200).json({
      success: true,
      users,
      page,
      pages: Math.ceil(count / pageSize),
      total: count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Update user role
// @route   PUT /api/v1/admin/users/:id/role
// @access  Private/Admin
exports.updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;

    if (!role || !["user", "admin"].includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role" });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.role = role;
    await user.save();

    res.status(200).json({
      success: true,
      data: user,
      message: `User role updated to ${role}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Update user subscription tier
// @route   PUT /api/v1/admin/users/:id/tier
// @access  Private/Admin
exports.updateUserTier = async (req, res, next) => {
  try {
    const { tier } = req.body;

    if (!tier || !["free", "plus", "pro"].includes(tier)) {
      return res.status(400).json({ success: false, message: "Invalid tier" });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.tier = tier;
    await user.save();

    res.status(200).json({
      success: true,
      data: user,
      message: `User tier updated to ${tier}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Update user plan (free <-> paid)
// @route   PUT /api/v1/admin/users/:id/plan
// @access  Private/Admin
exports.updateUserPlan = async (req, res, next) => {
  try {
    const { plan } = req.body;

    if (!plan || !["free", "paid"].includes(plan)) {
      return res.status(400).json({ success: false, message: "Invalid plan" });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.plan = plan;
    await user.save();

    res.status(200).json({
      success: true,
      data: user,
      message: `User plan updated to ${plan}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Toggle the "unlock all interviewers" override for a user (support grant)
// @route   PUT /api/v1/admin/users/:id/interview-unlock
// @access  Private/Admin
exports.updateUserInterviewUnlock = async (req, res) => {
  try {
    const { unlock } = req.body;
    if (typeof unlock !== "boolean") {
      return res
        .status(400)
        .json({ success: false, message: "`unlock` must be true or false" });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.unlockAllInterviewers = unlock;
    await user.save();

    res.status(200).json({
      success: true,
      data: { _id: user._id, email: user.email, unlockAllInterviewers: user.unlockAllInterviewers },
      message: unlock
        ? "All interviewers unlocked for this user"
        : "Interviewer unlock removed for this user",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Delete user
// @route   DELETE /api/v1/admin/users/:id
// @access  Private/Admin
exports.deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Use deleteOne() or findByIdAndDelete() instead of remove() which is deprecated
    await User.deleteOne({ _id: req.params.id });

    res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Get all transactions
// @route   GET /api/v1/admin/transactions
// @access  Private/Admin
exports.getAllTransactions = async (req, res, next) => {
  try {
    const pageSize = 10;
    const page = Number(req.query.page) || 1;

    const count = await Transaction.countDocuments();
    const transactions = await Transaction.find()
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .limit(pageSize)
      .skip(pageSize * (page - 1));

    res.status(200).json({
      success: true,
      transactions,
      page,
      pages: Math.ceil(count / pageSize),
      total: count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Get user details
// @route   GET /api/v1/admin/users/:id
// @access  Private/Admin
exports.getUserDetails = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select("-password");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const stats = {
      resumes: await Resume.countDocuments({ userId: req.params.id }),
      applications: await Application.countDocuments({ userId: req.params.id }),
    };

    const transactions = await Transaction.find({ userId: req.params.id }).sort({ createdAt: -1 });

    // Real-money payments (NGN) live in the Payment model, separate from credit
    // Transactions. Surface them so the admin sees subscriptions, top-ups,
    // download passes and failed checkouts for this user.
    const Payment = require("../models/Payment");
    const payments = await Payment.find({ userId: req.params.id }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: {
        user,
        stats,
        transactions,
        payments,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Get job search activity log
// @route   GET /api/v1/admin/job-searches
// @access  Private/Admin
exports.getJobSearches = async (req, res) => {
  try {
    const pageSize = 20;
    const page = Number(req.query.page) || 1;
    const { keyword, source, startDate, endDate, userId } = req.query;

    const filter = {};

    if (source && source !== "all") {
      filter.source = source;
    }

    if (userId) {
      filter.userId = userId;
    }

    if (keyword) {
      filter["query.keywords"] = { $regex: keyword, $options: "i" };
    }

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const count = await JobSearch.countDocuments(filter);
    const searches = await JobSearch.find(filter)
      .populate("userId", "firstName lastName email")
      .select("userId query source resultCount createdAt")
      .sort({ createdAt: -1 })
      .limit(pageSize)
      .skip(pageSize * (page - 1));

    // Compute engagement summary per search
    const searchIds = searches.map((s) => s._id);
    const engagementAgg = await JobSearch.aggregate([
      { $match: { _id: { $in: searchIds } } },
      { $unwind: { path: "$results", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$_id",
          clicks: { $sum: { $cond: [{ $eq: ["$results.clicked", true] }, 1, 0] } },
          saves: { $sum: { $cond: [{ $eq: ["$results.saved", true] }, 1, 0] } },
        },
      },
    ]);

    const engagementMap = {};
    engagementAgg.forEach((e) => {
      engagementMap[e._id.toString()] = { clicks: e.clicks, saves: e.saves };
    });

    const data = searches.map((s) => ({
      _id: s._id,
      user: s.userId,
      query: s.query,
      source: s.source,
      resultCount: s.resultCount,
      clicks: engagementMap[s._id.toString()]?.clicks || 0,
      saves: engagementMap[s._id.toString()]?.saves || 0,
      createdAt: s.createdAt,
    }));

    res.status(200).json({
      success: true,
      searches: data,
      page,
      pages: Math.ceil(count / pageSize),
      total: count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Get system settings
// @route   GET /api/v1/admin/settings
// @access  Private/Admin
exports.getSettings = async (req, res) => {
  try {
    const settings = await SettingsService.getSettings();
    res.status(200).json({ success: true, data: settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Update system settings
// @route   PUT /api/v1/admin/settings
// @access  Private/Admin
exports.updateSettings = async (req, res) => {
  try {
    const updates = req.body;

    // Validation check (optional, e.g. ensure nums are nums)

    // Check if credits changed (for notification)
    const oldSettings = await SettingsService.getSettings();
    const newSettings = await SettingsService.updateSettings(updates);

    // Detect price changes and notify users
    if (updates.credits) {
      const oldCredits = oldSettings.credits;
      const newCredits = newSettings.credits;

      if (
        oldCredits.analysisCost !== newCredits.analysisCost ||
        oldCredits.uploadCost !== newCredits.uploadCost
      ) {
        // NOTIFY ALL USERS (Simplified for now - can be background job)
        const title = "Pricing Update";
        const message = `Credit costs have been updated:\nAnalysis: ${newCredits.analysisCost} Credits\nUpload: ${newCredits.uploadCost} Credits`;

        await NotificationController.broadcast(
          {
            body: {
              // Simulate req.body structure for helper (though we should refactor shared logic)
              title,
              message,
              type: "system",
              link: "/credits",
            },
          },
          { json: () => {} }
        ); // Mock res object since we're calling controller method directly (Not ideal but works for speed)
        // Better: Extract logic to Service. But direct call works for MVP if we tweak NotificationController to be friendlier.
      }
    }

    res.status(200).json({ success: true, data: newSettings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Engagement & adoption analytics (logins, AI feature use, live
//          interview usage, conversion funnel) — all derived from data we
//          already store (LoginEvent, AICallLog, Transaction, User, DraftCV).
// @route   GET /api/v1/admin/engagement
// @access  Private/Admin
exports.getEngagementStats = async (req, res) => {
  try {
    const LoginEvent = require("../models/LoginEvent");
    const AICallLog = require("../models/AICallLog");
    const DraftCV = require("../models/DraftCV");

    const now = new Date();
    const DAY = 24 * 60 * 60 * 1000;
    const dayAgo = new Date(now - DAY);
    const weekAgo = new Date(now - 7 * DAY);
    const monthAgo = new Date(now - 30 * DAY);

    // --- Active users (distinct logins in window) ---
    const distinctLoginUsers = async (since) => {
      const r = await LoginEvent.aggregate([
        { $match: { createdAt: { $gte: since }, role: { $ne: "admin" } } },
        { $group: { _id: "$userId" } },
        { $count: "n" },
      ]);
      return r.length ? r[0].n : 0;
    };
    const [dau, wau, mau] = await Promise.all([
      distinctLoginUsers(dayAgo),
      distinctLoginUsers(weekAgo),
      distinctLoginUsers(monthAgo),
    ]);

    // Active users per day over the last 14 days (distinct users each day).
    const activeOverTime = await LoginEvent.aggregate([
      { $match: { createdAt: { $gte: new Date(now - 14 * DAY) }, role: { $ne: "admin" } } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            user: "$userId",
          },
        },
      },
      { $group: { _id: "$_id.day", users: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // --- AI feature adoption (last 30 days): calls + distinct users per op ---
    const adoptionRaw = await AICallLog.aggregate([
      { $match: { createdAt: { $gte: monthAgo } } },
      { $group: { _id: "$operation", calls: { $sum: 1 }, users: { $addToSet: "$userId" } } },
      { $project: { operation: "$_id", calls: 1, users: { $size: "$users" }, _id: 0 } },
      { $sort: { calls: -1 } },
    ]);

    // --- Live interview usage (from the "Live interview Ns (tier)" usage txns) ---
    const liveTxns = await Transaction.find({
      type: "usage",
      description: { $regex: /^Live interview \d+s/ },
    }).select("description userId");
    let sessions = 0;
    let totalSec = 0;
    let proSec = 0;
    let miniSec = 0;
    const liveUsers = new Set();
    for (const t of liveTxns) {
      const m = /^Live interview (\d+)s \((\w+)\)/.exec(t.description || "");
      if (!m) continue;
      const sec = Number(m[1]) || 0;
      sessions += 1;
      totalSec += sec;
      if (m[2] === "pro") proSec += sec;
      else miniSec += sec;
      if (t.userId) liveUsers.add(String(t.userId));
    }
    const liveUsage = {
      sessions,
      totalMinutes: Math.round(totalSec / 60),
      avgMinutes: sessions ? Number((totalSec / 60 / sessions).toFixed(1)) : 0,
      proMinutes: Math.round(proSec / 60),
      miniMinutes: Math.round(miniSec / 60),
      distinctUsers: liveUsers.size,
    };

    // --- Conversion funnel + churn (all-time, non-admin) ---
    const nonAdmin = { role: { $ne: "admin" } };
    const [signups, createdCvUsers, createdAppUsers, paidEver, activePaid, churned] =
      await Promise.all([
        User.countDocuments(nonAdmin),
        DraftCV.distinct("userId").then((a) => a.length),
        Application.distinct("userId").then((a) => a.length),
        User.countDocuments({ ...nonAdmin, hasEverPurchased: true }),
        User.countDocuments({ ...nonAdmin, "subscription.expiresAt": { $gt: now } }),
        // Ever paid but no longer in an active period = lapsed/churned.
        User.countDocuments({
          ...nonAdmin,
          hasEverPurchased: true,
          $or: [
            { "subscription.expiresAt": null },
            { "subscription.expiresAt": { $lte: now } },
          ],
        }),
      ]);

    res.status(200).json({
      success: true,
      data: {
        activeUsers: { dau, wau, mau },
        activeOverTime: activeOverTime.map((d) => ({ name: d._id, users: d.users })),
        featureAdoption: adoptionRaw,
        liveUsage,
        funnel: { signups, createdCv: createdCvUsers, createdApplication: createdAppUsers, paid: paidEver },
        subscriptions: { activePaid, churned },
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Real-money payments ledger (NGN), with status/purpose filters.
// @route   GET /api/v1/admin/payments
// @access  Private/Admin
exports.getPayments = async (req, res) => {
  try {
    const Payment = require("../models/Payment");
    const pageSize = 15;
    const page = Number(req.query.page) || 1;
    const { status, purpose } = req.query;

    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (purpose && purpose !== "all") filter.purpose = purpose;

    const count = await Payment.countDocuments(filter);
    const rawPayments = await Payment.find(filter)
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .limit(pageSize)
      .skip(pageSize * (page - 1))
      .lean();

    // Attach the human-readable catalog label so admins see "CV Download" rather
    // than the raw planId (download_single). Falls back to the id if the plan was
    // renamed/removed from the catalog.
    const { CATALOG } = require("../config/catalog");
    const payments = rawPayments.map((p) => ({
      ...p,
      planLabel: CATALOG[p.planId]?.label || p.planId || "—",
    }));

    // Status breakdown for the current filter (count + revenue per status).
    const summaryRaw = await Payment.aggregate([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 }, revenue: { $sum: "$amountNgn" } } },
    ]);
    const summary = summaryRaw.reduce(
      (acc, r) => ({ ...acc, [r._id]: { count: r.count, revenue: r.revenue } }),
      {}
    );

    res.status(200).json({
      success: true,
      payments,
      summary,
      page,
      pages: Math.ceil(count / pageSize),
      total: count,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Generate ad report screenshot via Puppeteer
// @route   POST /api/admin/report-screenshot
// @access  Admin
exports.generateReportScreenshot = async (req, res) => {
  try {
    const { templateId, stats, context } = req.body;

    if (!templateId || !stats || !context) {
      return res.status(400).json({
        success: false,
        message: "templateId, stats, and context are required",
      });
    }

    const validTemplates = ["social-proof", "growth-story", "impact-report"];
    if (!validTemplates.includes(templateId)) {
      return res.status(400).json({
        success: false,
        message: `Invalid template. Must be one of: ${validTemplates.join(", ")}`,
      });
    }

    const buffer = await screenshotService.captureTemplate(templateId, stats, context);

    res.set({
      "Content-Type": "image/png",
      "Content-Length": buffer.length,
      "Content-Disposition": `attachment; filename="applyright-ad-${templateId}-${new Date().toISOString().split("T")[0]}.png"`,
      "Cache-Control": "no-store",
    });
    res.send(buffer);
  } catch (err) {
    console.error("[generateReportScreenshot] Error:", err);
    res.status(500).json({ success: false, message: "Failed to generate screenshot" });
  }
};
