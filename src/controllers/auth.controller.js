const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

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
const registerUser = async (req, res) => {
    const { email, password, referralCode } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Please add all fields' });
    }

    // Check if user exists
    const userExists = await User.findOne({ email });

    if (userExists) {
        return res.status(400).json({ message: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create unique referral code for new user
    let newReferralCode = generateReferralCode();
    // Ensure uniqueness (simple check loop)
    let codeExists = await User.findOne({ referralCode: newReferralCode });
    while (codeExists) {
        newReferralCode = generateReferralCode();
        codeExists = await User.findOne({ referralCode: newReferralCode });
    }

    // Handle Referral Logic
    let referrer = null;
    const initialCredits = 30; // Default - no bonus for new user
    const REFERRAL_BONUS = 10; // Reduced for ad-based revenue model

    if (referralCode) {
        referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
    }

    // Create user
    const user = await User.create({
        email,
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
            firstName: user.firstName,
            lastName: user.lastName,
            referralCode: user.referralCode,
            credits: user.credits,
            settings: user.settings,
            token: generateToken(user.id),
        });
    } else {
        res.status(400).json({ message: 'Invalid user data' });
    }
};

// @desc    Authenticate a user
// @route   POST /api/auth/login
// @access  Public
const loginUser = async (req, res) => {
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
            token: generateToken(user.id),
        });
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
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
const updateProfile = async (req, res) => {
    const user = await User.findById(req.user.id);

    if (user) {
        user.firstName = req.body.firstName || user.firstName;
        user.lastName = req.body.lastName || user.lastName;
        user.currentStatus = req.body.currentStatus || user.currentStatus;

        // Update Education object if provided
        if (req.body.education) {
            user.education = {
                ...user.education, // Keep existing fields if partial update (though Mongoose might overwrite subdocs differently, this spreads properties)
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

        // Handle Plan Upgrade (Mock logic)
        if (req.body.plan) {
            user.plan = req.body.plan;
        }

        const updatedUser = await user.save();

        res.json({
            _id: updatedUser.id,
            email: updatedUser.email,
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
};

module.exports = {
    registerUser,
    loginUser,
    getMe,
    updateProfile,
};
