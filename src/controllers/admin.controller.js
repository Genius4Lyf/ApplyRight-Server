const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Resume = require("../models/Resume");
const Job = require("../models/Job");
const Application = require("../models/Application");
const SettingsService = require("../services/settings.service");
const NotificationController = require("./notification.controller");

// @desc    Get dashboard stats
// @route   GET /api/v1/admin/stats
// @access  Private/Admin
exports.getDashboardStats = async (req, res, next) => {
    try {
        const period = req.query.period || 'monthly'; // 'monthly' (default) or 'daily'
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const month = parseInt(req.query.month) || new Date().getMonth() + 1; // 1-12

        const totalUsers = await User.countDocuments({ role: { $ne: 'admin' } });
        const totalResumes = await Resume.countDocuments();
        const totalApplications = await Application.countDocuments();

        // Calculate total credits (current pool)
        const creditsResult = await User.aggregate([
            { $match: { role: { $ne: 'admin' } } },
            { $group: { _id: null, total: { $sum: "$credits" } } },
        ]);
        const totalCredits = creditsResult.length > 0 ? creditsResult[0].total : 0;

        // Calculate credits usage over time (Chart Data)
        let dateGroupFormat;
        let matchStage = {};

        if (period === 'daily') {
            // View daily stats for a specific month and year
            // Note: Months in JS Date are 0-indexed (0=Jan), but we expect 1-12 from query
            const startDate = new Date(year, month - 1, 1);
            const endDate = new Date(year, month, 0, 23, 59, 59, 999); // Last day of month

            matchStage = {
                createdAt: { $gte: startDate, $lte: endDate }
            };
            dateGroupFormat = "%Y-%m-%d";
        } else {
            // View monthly stats for a specific year (Default)
            const startDate = new Date(year, 0, 1);
            const endDate = new Date(year, 11, 31, 23, 59, 59, 999);

            matchStage = {
                createdAt: { $gte: startDate, $lte: endDate }
            };
            dateGroupFormat = "%Y-%m"; // Groups by YYYY-MM
        }

        const chartStats = await Transaction.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: { $dateToString: { format: dateGroupFormat, date: "$createdAt" } },
                    credits: { $sum: "$amount" }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Format chart data for frontend
        const chartData = chartStats.map(item => ({
            name: item._id,
            credits: item.credits
        }));


        // Get recent 5 users
        const recentUsers = await User.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .select("-password");

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
            role: { $ne: 'admin' }
        });

        // --- Feature Usage Stats ---

        // 1. Creation Method (Upload vs Scratch)
        // We look at DraftCVs. explicit 'source' field is best, but we fall back to title heuristic for older docs if needed.
        const allDrafts = await require('../models/DraftCV').find({}, 'source title');

        let uploadCount = 0;
        let scratchCount = 0;

        allDrafts.forEach(draft => {
            if (draft.source === 'upload') {
                uploadCount++;
            } else if (draft.source === 'scratch') {
                scratchCount++;
            } else if (draft.title === 'Uploaded Resume') {
                uploadCount++; // Heuristic for older documents without 'source' field
            } else {
                scratchCount++; // Heuristic: if it's named anything else, it was likely typed
            }
        });

        const creationMethod = {
            upload: uploadCount,
            scratch: scratchCount,
            unknown: 0 // we've bucketed everything via heuristics
        };

        // 2. CV Generation (AI Optimizations & Downloads)
        // AI Optimizations = Total Applications (since every App is an optimization/analysis result)
        const totalOptimizations = await Application.countDocuments();

        // Downloads = Sum of exportCount from Applications + DraftCVs
        const appExports = await Application.aggregate([{ $group: { _id: null, total: { $sum: "$exportCount" } } }]);
        const draftExports = await require('../models/DraftCV').aggregate([{ $group: { _id: null, total: { $sum: "$exportCount" } } }]);

        const totalDownloads = (appExports[0]?.total || 0) + (draftExports[0]?.total || 0);

        // 3. Analysis Usage (With Job Description)
        // An Application implies a Job ID exists (schema requires it). So totalApplications is effectively analysis usage.
        // But maybe we want to distinguish "Detailed Analysis" vs just "Saved".
        // Schema: jobId is required. So all Applications are analyses.

        // 4. Template Popularity (Based on Downloads)
        // Lazy load DownloadLog if not imported at top
        const DownloadLog = require('../models/DownloadLog');
        const ALL_TEMPLATES = require('../data/templates'); // Import master list

        const downloadStats = await DownloadLog.aggregate([
            { $group: { _id: "$templateId", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);

        // Merge with master list to ensure ALL templates are shown, even with 0 downloads
        const templateStats = ALL_TEMPLATES.map(template => {
            const found = downloadStats.find(stat => stat._id === template.id);
            return {
                name: template.name,
                count: found ? found.count : 0
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
                downloads: totalDownloads
            },
            templatePopularity: templateStats // Return FULL list
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
                featureUsage // NEW
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
        const page = Number(req.query.page) || 1;

        const keyword = req.query.keyword
            ? {
                $or: [
                    { firstName: { $regex: req.query.keyword, $options: "i" } },
                    { lastName: { $regex: req.query.keyword, $options: "i" } },
                    { email: { $regex: req.query.keyword, $options: "i" } },
                ],
            }
            : {};

        const count = await User.countDocuments({ ...keyword });
        const users = await User.find({ ...keyword })
            .select("-password")
            .sort({ createdAt: -1 })
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

        const transactions = await Transaction.find({ userId: req.params.id })
            .sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            data: {
                user,
                stats,
                transactions
            }
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

            if (oldCredits.analysisCost !== newCredits.analysisCost ||
                oldCredits.uploadCost !== newCredits.uploadCost) {

                // NOTIFY ALL USERS (Simplified for now - can be background job)
                const title = "Pricing Update";
                const message = `Credit costs have been updated:\nAnalysis: ${newCredits.analysisCost} Credits\nUpload: ${newCredits.uploadCost} Credits`;

                await NotificationController.broadcast({
                    body: { // Simulate req.body structure for helper (though we should refactor shared logic)
                        title,
                        message,
                        type: 'system',
                        link: '/credits'
                    }
                }, { json: () => { } }); // Mock res object since we're calling controller method directly (Not ideal but works for speed)
                // Better: Extract logic to Service. But direct call works for MVP if we tweak NotificationController to be friendlier.
            }
        }

        res.status(200).json({ success: true, data: newSettings });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
};
