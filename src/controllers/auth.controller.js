const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { sendWhatsAppOTP } = require('../utils/whatsapp.service');

const generateReferralCode = () => {
    // Basic code generation: Random 8 char alphanumeric
    return Math.random().toString(36).substring(2, 10).toUpperCase();
};

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
const registerUser = async (req, res, next) => {
    try {
        const { email, password, phone, referralCode } = req.body;

        if (!email || !password || !phone) {
            return res.status(400).json({ message: 'Please add all fields' });
        }

        // Validate email format and domain
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(com|org|net|edu|gov|mil|co|io|ai|tech|dev|app|uk|ca|au|de|fr|jp|cn|in|br|mx|es|it|nl|se|no|dk|fi|ch|at|be|ie|nz|sg|hk|my|ph|th|vn|id|kr|tw|za|ae|sa|eg|ng|ke|gh|tz|ug|zm|zw|bw|mw|na|sz|ls|gm|sl|lr|sn|ml|bf|ne|td|cf|cm|ga|cg|cd|ao|mz|mg|sc|mu|re|yt|km|dj|so|et|er|sd|ss|ly|tn|dz|ma|eh|mr|cv|st|gq|gw|bi|rw|vu|fj|pg|sb|nc|pf|ws|to|tv|ki|nr|fm|mh|pw|mp|gu|as|vi|pr|do|jm|tt|bb|gd|lc|vc|ag|kn|dm|bs|ky|bm|tc|vg|ai|ms|gl|fo|is|li|mc|sm|va|ad|mt|cy|tr|gr|bg|ro|hu|cz|sk|pl|ua|by|ru|lt|lv|ee|md|ge|am|az|kz|uz|tm|kg|tj|mn|kp|mm|la|kh|bn|mv|bt|np|lk|bd|pk|af|ir|iq|sy|lb|jo|il|ps|ye|om|kw|bh|qa|info|biz|name|pro|coop|aero|museum|travel|jobs|mobi|tel|xxx|asia|cat|post|xxx)$/i;

        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: 'Please enter a valid email address with a recognized domain (e.g., @gmail.com, @outlook.com, @company.com)' });
        }

        // Validate phone number format (E.164: +[country code][number])
        const phoneRegex = /^\+[1-9]\d{1,14}$/;
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ message: 'Please enter a valid international phone number with country code (e.g., +12025551234)' });
        }

        // Check if user exists (email or phone)
        const userExists = await User.findOne({
            $or: [{ email }, { phone }]
        });

        if (userExists) {
            return res.status(400).json({ message: 'User already exists' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create unique referral code for new user
        let newReferralCode = generateReferralCode();
        let codeExists = await User.findOne({ referralCode: newReferralCode });
        while (codeExists) {
            newReferralCode = generateReferralCode();
            codeExists = await User.findOne({ referralCode: newReferralCode });
        }

        // Handle Referral Logic
        let referrer = null;
        const initialCredits = 15; // Default - no bonus for new user
        const REFERRAL_BONUS = 10; // Reduced for ad-based revenue model

        if (referralCode) {
            referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
        }

        // Create user
        const user = await User.create({
            email,
            phone,
            password: hashedPassword,
            referralCode: newReferralCode,
            credits: initialCredits,
            referredBy: referrer ? referrer._id : null
        });

        if (user) {
            // Only award credits to the REFERRER, not the new user
            if (referrer) {
                // Award Referrer
                referrer.credits += REFERRAL_BONUS;
                referrer.referralCount += 1;
                await referrer.save();

                await Transaction.create({
                    userId: referrer.id,
                    amount: REFERRAL_BONUS,
                    type: 'streak_bonus',
                    description: `Referral Bonus (Invited ${user.email})`,
                    status: 'completed'
                });
            }

            res.status(201).json({
                _id: user.id,
                email: user.email,
                phone: user.phone,
                firstName: user.firstName,
                lastName: user.lastName,
                referralCode: user.referralCode,
                credits: user.credits,
                settings: user.settings,
                unlockedTemplates: user.unlockedTemplates,
                token: generateToken(user.id),
            });
        } else {
            res.status(400).json({ message: 'Invalid user data' });
        }
    } catch (error) {
        next(error);
    }
};

// @desc    Authenticate a user
// @route   POST /api/auth/login
// @access  Public
const loginUser = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        // Check for user email
        const user = await User.findOne({ email });

        if (user && (await bcrypt.compare(password, user.password))) {
            // Generate referral code if user doesn't have one (for existing users)
            if (!user.referralCode) {
                let newReferralCode = generateReferralCode();
                let codeExists = await User.findOne({ referralCode: newReferralCode });
                while (codeExists) {
                    newReferralCode = generateReferralCode();
                    codeExists = await User.findOne({ referralCode: newReferralCode });
                }
                user.referralCode = newReferralCode;
                await user.save();
            }

            res.json({
                _id: user.id,
                email: user.email,
                phone: user.phone,
                firstName: user.firstName,
                lastName: user.lastName,
                credits: user.credits,
                phoneNumber: user.phoneNumber,
                location: user.location,
                skills: user.skills,
                experience: user.experience,
                education: user.education,
                settings: user.settings,
                onboardingCompleted: user.onboardingCompleted,
                referralCode: user.referralCode,
                unlockedTemplates: user.unlockedTemplates,
                token: generateToken(user.id),
            });
        } else {
            res.status(401).json({ message: 'Invalid credentials' });
        }
    } catch (error) {
        next(error);
    }
};

// @desc    Get user data
// @route   GET /api/auth/me
// @access  Private
const getMe = async (req, res) => {
    res.status(200).json(req.user);
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
const updateProfile = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id);

        if (user) {
            user.firstName = req.body.firstName || user.firstName;
            user.lastName = req.body.lastName || user.lastName;
            user.currentStatus = req.body.currentStatus || user.currentStatus;

            // Update Education object if provided
            if (req.body.education) {
                user.education = {
                    ...user.education,
                    ...req.body.education
                };
            }

            // Update Settings
            if (req.body.settings) {
                user.settings = {
                    ...user.settings,
                    ...req.body.settings
                };
            }

            // REMOVED: Mock Plan Upgrade Logic (Security Vulnerability)

            const updatedUser = await user.save();

            res.json({
                _id: updatedUser.id,
                email: updatedUser.email,
                phone: updatedUser.phone,
                firstName: updatedUser.firstName,
                lastName: updatedUser.lastName,
                plan: updatedUser.plan,
                education: updatedUser.education,
                currentStatus: updatedUser.currentStatus,
                settings: updatedUser.settings,
                token: generateToken(updatedUser.id),
            });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    } catch (error) {
        next(error);
    }
};

// @desc    Forgot Password
// @route   POST /api/auth/forgotpassword
// @access  Public
const forgotPassword = async (req, res) => {
    const { phone } = req.body;

    try {
        const user = await User.findOne({ phone });

        if (!user) {
            return res.status(404).json({ message: 'User with this phone number not found' });
        }

        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Hash OTP and save to database
        const salt = await bcrypt.genSalt(10);
        user.resetPasswordToken = await bcrypt.hash(otp, salt);
        user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 Minutes

        await user.save();

        try {
            await sendWhatsAppOTP(user.phone, otp);
            res.status(200).json({ success: true, data: 'WhatsApp OTP sent' });
        } catch (err) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save();
            res.status(500).json({ message: 'WhatsApp message could not be sent' });
        }
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// @desc    Reset Password
// @route   POST /api/auth/resetpassword
// @access  Public
const resetPassword = async (req, res) => {
    const { phone, otp, password } = req.body;

    try {
        const user = await User.findOne({
            phone,
            resetPasswordExpire: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid token or token has expired' });
        }

        // Check OTP
        const isMatch = await bcrypt.compare(otp, user.resetPasswordToken);

        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        // Set new password
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(password, salt);

        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;

        await user.save();

        res.status(200).json({ success: true, data: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    registerUser,
    loginUser,
    getMe,
    updateProfile,
    forgotPassword,
    resetPassword
};
