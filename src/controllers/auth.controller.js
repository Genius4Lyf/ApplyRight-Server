const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
const registerUser = async (req, res) => {
    const { email, password } = req.body;

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

    // Create user
    const user = await User.create({
        email,
        password: hashedPassword,
    });

    if (user) {
        res.status(201).json({
            _id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
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
        res.json({
            _id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            currentStatus: user.currentStatus,
            plan: user.plan,
            education: user.education,
            settings: user.settings,
            onboardingCompleted: user.onboardingCompleted,
            token: generateToken(user.id),
        });
    } else {
        res.status(400).json({ message: 'Invalid credentials' });
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
