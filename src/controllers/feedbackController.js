const Feedback = require('../models/Feedback');
const User = require('../models/User');

// @desc    Check if user exists and return basic info
// @route   POST /api/v1/feedback/check-user
// @access  Public
exports.checkUser = async (req, res, next) => {
    try {
        const { contactValue } = req.body;

        if (!contactValue) {
            return res.status(400).json({
                success: false,
                error: 'Please provide an email or phone number'
            });
        }

        let user = null;

        // Check if input looks like an email or phone
        if (contactValue.includes('@')) {
            // Email search
            user = await User.findOne({ email: contactValue.toLowerCase() }).select('firstName lastName email phone');
        } else {
            // Phone search with flexible matching

            // Strategy 1: Try exact match first
            user = await User.findOne({ phone: contactValue }).select('firstName lastName email phone');

            // Strategy 2: If not found, normalize and try matching digits
            if (!user) {
                // Extract only digits from input
                const phoneDigits = contactValue.replace(/\D/g, '');

                // Only attempt fuzzy matching if we have at least 7 digits (reasonable phone length)
                if (phoneDigits.length >= 7) {
                    // Try to find users whose phone ends with these digits
                    let regex = new RegExp(phoneDigits + '$');
                    user = await User.findOne({ phone: regex }).select('firstName lastName email phone');

                    // Strategy 3: If still not found and starts with 0, try without the leading 0
                    // This handles cases like 09017134882 -> +2349017134882 (E.164 format)
                    if (!user && phoneDigits.startsWith('0')) {
                        const digitsWithoutLeadingZero = phoneDigits.substring(1);
                        regex = new RegExp(digitsWithoutLeadingZero + '$');
                        user = await User.findOne({ phone: regex }).select('firstName lastName email phone');
                    }
                }
            }
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.status(200).json({
            success: true,
            data: {
                exists: true,
                firstName: user.firstName,
                lastName: user.lastName
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            error: 'Server Error'
        });
    }
};

// @desc    Submit feedback
// @route   POST /api/v1/feedback
// @access  Public
exports.submitFeedback = async (req, res, next) => {
    try {
        const { contactValue, message } = req.body;

        if (!contactValue || !message) {
            return res.status(400).json({
                success: false,
                error: 'Please provide contact info and a message'
            });
        }

        let user = null;

        // Check if input looks like an email or phone
        if (contactValue.includes('@')) {
            // Email search
            user = await User.findOne({ email: contactValue.toLowerCase() });
        } else {
            // Phone search with flexible matching

            // Strategy 1: Try exact match first
            user = await User.findOne({ phone: contactValue });

            // Strategy 2: If not found, normalize and try matching digits
            if (!user) {
                // Extract only digits from input
                const phoneDigits = contactValue.replace(/\D/g, '');

                // Only attempt fuzzy matching if we have at least 7 digits (reasonable phone length)
                if (phoneDigits.length >= 7) {
                    // Try to find users whose phone ends with these digits
                    let regex = new RegExp(phoneDigits + '$');
                    user = await User.findOne({ phone: regex });

                    // Strategy 3: If still not found and starts with 0, try without the leading 0
                    // This handles cases like 09017134882 -> +2349017134882 (E.164 format)
                    if (!user && phoneDigits.startsWith('0')) {
                        const digitsWithoutLeadingZero = phoneDigits.substring(1);
                        regex = new RegExp(digitsWithoutLeadingZero + '$');
                        user = await User.findOne({ phone: regex });
                    }
                }
            }
        }

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found. Please sign up to submit feedback.'
            });
        }

        const feedback = await Feedback.create({
            user: user._id,
            contactValue,
            message
        });

        res.status(201).json({
            success: true,
            data: feedback
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            error: 'Server Error'
        });
    }
};

// @desc    Get all feedbacks (Admin only)
// @route   GET /api/v1/feedback
// @access  Private/Admin
exports.getAllFeedbacks = async (req, res, next) => {
    try {
        const feedbacks = await Feedback.find()
            .populate('user', 'firstName lastName email')
            .sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            count: feedbacks.length,
            data: feedbacks
        });
    } catch (error) {
        console.error('Get all feedbacks error:', error);
        res.status(500).json({
            success: false,
            error: 'Server Error'
        });
    }
};

// @desc    Promote user to admin (Secret endpoint)
// @route   POST /api/v1/feedback/promote
// @access  Private
exports.promoteToAdmin = async (req, res, next) => {
    try {
        const { secretKey } = req.body;

        // Simple secret key check - in production use env var
        const ADMIN_SECRET = process.env.ADMIN_SECRET || 'applyright_admin_2026';

        if (secretKey !== ADMIN_SECRET) {
            return res.status(401).json({
                success: false,
                error: 'Invalid secret key'
            });
        }

        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        user.role = 'admin';
        await user.save();

        res.status(200).json({
            success: true,
            data: {
                id: user._id,
                firstName: user.firstName,
                email: user.email,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Promote admin error:', error);
        res.status(500).json({
            success: false,
            error: 'Server Error'
        });
    }
};
// @desc    Toggle feedback featured status
// @route   PUT /api/v1/feedback/:id/feature
// @access  Private/Admin
exports.toggleFeatured = async (req, res, next) => {
    try {
        const feedback = await Feedback.findById(req.params.id);

        if (!feedback) {
            return res.status(404).json({
                success: false,
                error: 'Feedback not found'
            });
        }

        if (!feedback.isFeatured) {
            // Turning ON featured status - check limit
            const featuredCount = await Feedback.countDocuments({ isFeatured: true });
            if (featuredCount >= 3) {
                return res.status(400).json({
                    success: false,
                    error: 'Maximum 3 featured feedbacks allowed. Please unfeature one first.'
                });
            }
        }

        feedback.isFeatured = !feedback.isFeatured;
        await feedback.save();

        res.status(200).json({
            success: true,
            data: feedback
        });
    } catch (error) {
        console.error('Toggle featured error:', error);
        res.status(500).json({
            success: false,
            error: 'Server Error'
        });
    }
};

// @desc    Get featured feedbacks
// @route   GET /api/v1/feedback/featured
// @access  Public
exports.getFeaturedFeedbacks = async (req, res, next) => {
    try {
        const feedbacks = await Feedback.find({ isFeatured: true })
            .populate('user', 'firstName lastName')
            .sort({ createdAt: -1 })
            .limit(6); // Limit to 6 for the showcase

        res.status(200).json({
            success: true,
            count: feedbacks.length,
            data: feedbacks
        });
    } catch (error) {
        console.error('Get featured feedbacks error:', error);
        res.status(500).json({
            success: false,
            error: 'Server Error'
        });
    }
};
