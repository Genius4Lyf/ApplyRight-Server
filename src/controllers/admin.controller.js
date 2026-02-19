const User = require("../models/User");
const Transaction = require("../models/Transaction");
const Resume = require("../models/Resume");
const Job = require("../models/Job");
const Application = require("../models/Application");

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
        // Actually, let's just use the 'source' field. Unknowns can be grouped or ignored.
        const creationStats = await require('../models/DraftCV').aggregate([
            { $group: { _id: "$source", count: { $sum: 1 } } }
        ]);
        const creationMethod = {
            upload: creationStats.find(s => s._id === 'upload')?.count || 0,
            scratch: creationStats.find(s => s._id === 'scratch')?.count || 0,
            unknown: creationStats.find(s => s._id === 'unknown' || !s._id)?.count || 0
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

        // 4. Template Popularity
        const templateStats = await Application.aggregate([
            { $group: { _id: "$templateId", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]);

        const featureUsage = {
            creationMethod,
            cvGeneration: {
                optimizations: totalOptimizations,
                downloads: totalDownloads
            },
            templatePopularity: templateStats.map(t => ({ name: t._id || 'Standard', count: t.count }))
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
