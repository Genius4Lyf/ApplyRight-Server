const User = require('../models/User');

exports.updateProfile = async (req, res) => {
    try {
        const { firstName, lastName, currentStatus, education, careerGoals, skills, onboardingCompleted } = req.body;

        // Build update object
        const updateFields = {};
        if (firstName) updateFields.firstName = firstName;
        if (lastName) updateFields.lastName = lastName;
        if (currentStatus) updateFields.currentStatus = currentStatus;
        if (education) updateFields.education = education;
        if (careerGoals) updateFields.careerGoals = careerGoals;
        if (skills) updateFields.skills = skills;
        if (typeof onboardingCompleted !== 'undefined') updateFields.onboardingCompleted = onboardingCompleted;

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $set: updateFields },
            { new: true }
        ).select('-password');

        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

exports.getProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};
