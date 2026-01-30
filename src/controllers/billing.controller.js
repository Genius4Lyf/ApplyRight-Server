const User = require('../models/User');
const Transaction = require('../models/Transaction');

// @desc    Get current user credit balance
// @route   GET /api/billing/balance
// @access  Private
exports.getBalance = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        res.json({ credits: user.credits });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Add credits to user (Simulated Payment / Admin)
// @route   POST /api/billing/add
// @access  Private (Should be Admin or Webhook, but keeping Private for prototype)
exports.addCredits = async (req, res) => {
    const { amount, description } = req.body;

    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        user.credits += parseInt(amount, 10);
        await user.save();

        // Record Transaction
        await Transaction.create({
            userId: user.id,
            amount: amount,
            type: 'purchase',
            description: description || 'Credit Top-up',
            status: 'completed'
        });

        res.json({ message: 'Credits added successfully', credits: user.credits });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Deduct credits for usage (Internal Service Call)
// @route   POST /api/billing/usage
// @access  Private
exports.deductCredits = async (req, res) => {
    const { cost, serviceName } = req.body;

    try {
        const user = await User.findById(req.user.id);

        if (user.credits < cost) {
            return res.status(400).json({ message: 'Insufficient credits', error: 'INSUFFICIENT_CREDITS' });
        }

        user.credits -= parseInt(cost, 10);
        await user.save();

        // Record Transaction
        await Transaction.create({
            userId: user.id,
            amount: -cost, // Negative for deduction
            type: 'usage',
            description: `Used for ${serviceName}`,
            status: 'completed'
        });

        res.json({ success: true, credits: user.credits });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get transaction history
// @route   GET /api/billing/transactions
// @access  Private
exports.getTransactions = async (req, res) => {
    try {
        const transactions = await Transaction.find({ userId: req.user.id }).sort({ createdAt: -1 });
        res.json(transactions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
