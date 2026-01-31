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

// @desc    Watch Ad Reward
// @route   POST /api/billing/watch-ad
// @access  Private
exports.watchAd = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Check daily limit
        const watchCount = await Transaction.countDocuments({
            userId: user.id,
            type: 'ad_reward',
            createdAt: { $gte: today }
        });

        if (watchCount >= 3) {
            return res.status(429).json({
                message: 'Daily ad limit reached',
                watchCount,
                maxDaily: 3
            });
        }

        // --- Streak Logic ---
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        let streakBonus = 0;
        let streakMessage = '';

        if (!user.adStreak) {
            user.adStreak = { current: 0, longest: 0, lastWatchDate: null };
        }

        const lastWatchDate = user.adStreak.lastWatchDate ? new Date(user.adStreak.lastWatchDate) : null;

        // Normalize dates to midnight for comparison
        const lastWatchMidnight = lastWatchDate ? new Date(lastWatchDate.setHours(0, 0, 0, 0)) : null;

        if (lastWatchMidnight && lastWatchMidnight.getTime() === today.getTime()) {
            // Already watched today, streak continues, no change to count
        } else if (lastWatchMidnight && lastWatchMidnight.getTime() === yesterday.getTime()) {
            // Watched yesterday, increment streak
            user.adStreak.current += 1;
        } else {
            // Missed a day or first time, reset/start streak
            user.adStreak.current = 1;
        }

        // Update Longest
        if (user.adStreak.current > user.adStreak.longest) {
            user.adStreak.longest = user.adStreak.current;
        }
        user.adStreak.lastWatchDate = new Date(); // Set to now

        // Check for Bonuses
        // Only award bonus on the FIRST watch of the milestone day (when watchCount is 0 for that day? No, actually we just updated current streak)
        // We only want to award the streak bonus ONCE per day, preferably on the first watch that triggers the increment.
        // Since we only increment 'current' once per day (logic above), we can check if we just hit a milestone.
        // Wait, the logic above increments current ONLY if lastWatch was yesterday. If lastWatch was today, current doesnt change.
        // So checking (current === 3) is safe, it will only be true on the 3rd day.

        // NOTE: We need to make sure we don't double award if they watch 3 videos on day 3.
        // The logic `if (lastWatchMidnight === today)` handles this - we don't increment.
        // So `user.adStreak.current` will be stable.
        // BUT, we need to know if this SPECIFIC watch TRIGGERED the streak increment to award the bonus.

        const isStreakIncremented = (!lastWatchMidnight || lastWatchMidnight.getTime() !== today.getTime());

        if (isStreakIncremented) {
            if (user.adStreak.current === 3) {
                streakBonus = 5;
                streakMessage = '🔥 3-Day Streak Bonus!';
            } else if (user.adStreak.current === 7) {
                streakBonus = 15;
                streakMessage = '🔥 7-Day Streak Bonus!';
            }
        }

        // Add Credits
        const REWARD_AMOUNT = 5;
        const TOTAL_REWARD = REWARD_AMOUNT + streakBonus;

        user.credits += TOTAL_REWARD;
        await user.save();

        // Record Transaction
        await Transaction.create({
            userId: user.id,
            amount: REWARD_AMOUNT,
            type: 'ad_reward',
            description: 'Watched advertisement',
            status: 'completed'
        });

        if (streakBonus > 0) {
            await Transaction.create({
                userId: user.id,
                amount: streakBonus,
                type: 'streak_bonus',
                description: streakMessage,
                status: 'completed'
            });
        }

        res.json({
            success: true,
            credits: user.credits,
            added: TOTAL_REWARD,
            watchCount: watchCount + 1,
            maxDaily: 3,
            streak: user.adStreak.current,
            streakBonus,
            streakMessage
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get Ad Watch Stats
// @route   GET /api/billing/ad-stats
// @access  Private
exports.getWatchStats = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const watchCount = await Transaction.countDocuments({
            userId: req.user.id,
            type: 'ad_reward',
            createdAt: { $gte: today }
        });

        // Find last watch time for cooldown (Phase 2)
        const lastWatch = await Transaction.findOne({
            userId: req.user.id,
            type: 'ad_reward',
            createdAt: { $gte: today }
        }).sort({ createdAt: -1 });

        const user = await User.findById(req.user.id);

        res.json({
            watchCount,
            maxDaily: 3,
            lastWatch: lastWatch ? lastWatch.createdAt : null,
            streak: user.adStreak ? user.adStreak.current : 0
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
