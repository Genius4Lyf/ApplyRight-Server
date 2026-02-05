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
        const { type } = req.body; // 'video' (default) or 'banner'
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Get watch count for tracking (no limit enforced)
        const watchCount = await Transaction.countDocuments({
            userId: user.id,
            type: 'ad_reward',
            createdAt: { $gte: today }
        });

        // Determine Reward & Streak Eligibility
        // Default is now 'offer' (2 credits) since Monetag is link-based
        let REWARD_AMOUNT = 2;
        let eligibleForStreak = false;

        // Pending Update: If we integrate a REAL video player later, we can enable this
        if (type === 'video_real') {
            REWARD_AMOUNT = 10;
            eligibleForStreak = true;
        }

        // --- Streak Logic (Only for Videos) ---
        let streakBonus = 0;
        let streakMessage = '';

        if (eligibleForStreak) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            if (!user.adStreak) {
                user.adStreak = { current: 0, longest: 0, lastWatchDate: null };
            }

            const lastWatchDate = user.adStreak.lastWatchDate ? new Date(user.adStreak.lastWatchDate) : null;
            const lastWatchMidnight = lastWatchDate ? new Date(lastWatchDate.setHours(0, 0, 0, 0)) : null;

            if (lastWatchMidnight && lastWatchMidnight.getTime() === today.getTime()) {
                // Already watched today, streak continues
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
            user.adStreak.lastWatchDate = new Date();

            // Check for Bonuses
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
        }

        const TOTAL_REWARD = REWARD_AMOUNT + streakBonus;

        user.credits += TOTAL_REWARD;
        await user.save();

        // Record Transaction
        await Transaction.create({
            userId: user.id,
            amount: REWARD_AMOUNT,
            type: 'ad_reward',
            description: type === 'banner' ? 'Clicked Sponsored Banner' : 'Watched Video Ad',
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
            maxDaily: 999, // Unlimited
            streak: user.adStreak ? user.adStreak.current : 0,
            streakBonus,
            streakMessage,
            type: type || 'video'
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
            maxDaily: 999, // Unlimited
            lastWatch: lastWatch ? lastWatch.createdAt : null,
            streak: user.adStreak ? user.adStreak.current : 0
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
};
// @desc    Verify Paystack Payment
// @route   POST /api/billing/verify-payment
// @access  Private
exports.verifyPayment = async (req, res) => {
    const { reference } = req.body;

    try {
        if (!reference) {
            return res.status(400).json({ message: 'No transaction reference provided' });
        }

        // 1. Verify with Paystack API
        const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (!data.status || data.data.status !== 'success') {
            return res.status(400).json({ message: 'Transaction verification failed' });
        }

        const { amount, metadata } = data.data; // Amount is in Kobo (NGN * 100)

        // 2. Check if transaction already exists
        const existingTx = await Transaction.findOne({ reference });
        if (existingTx) {
            return res.status(400).json({ message: 'Transaction already verified' });
        }

        const user = await User.findById(req.user.id);

        // 3. Calculate Credits (Simulated logic based on amount paid)
        // Adjust these rates as needed. Current packages:
        // 50 Credits = NGN 2000 roughly? Let's assume metadata carries the credit amount for safety,
        // or we map exact amounts to credits.
        // Ideally, pass 'credits' in metadata from frontend.

        let creditsToAdd = 0;
        if (metadata && metadata.credits) {
            creditsToAdd = parseInt(metadata.credits, 10);
        } else {
            // Fallback mapper (e.g. 1 NGN = 0.05 credits? User buys packages)
            // 20 Credits = $5 (~5000 NGN)
            // 50 Credits = $10 (~10000 NGN)
            // 150 Credits = $25 (~25000 NGN)
            // Using a safe fallback if frontend metadata fails
            creditsToAdd = Math.floor((amount / 100) / 200); // 1 credit per 200 NGN rough estimate
        }

        // 4. Update User Balance
        user.credits += creditsToAdd;
        await user.save();

        // 5. Record Transaction
        await Transaction.create({
            userId: user.id,
            amount: creditsToAdd, // Store credits amount, not currency amount for internal consistency
            type: 'purchase',
            description: `Purchased ${creditsToAdd} Credits`,
            status: 'completed',
            reference: reference, // Paystack Ref
            paymentGateway: 'paystack'
        });

        res.json({
            success: true,
            credits: user.credits,
            added: creditsToAdd,
            message: 'Payment verified successfully'
        });

    } catch (error) {
        console.error('Payment Verification Error:', error);
        res.status(500).json({ message: 'Payment verification failed server error' });
    }
};

// @desc    Unlock a template
// @route   POST /api/billing/unlock-template
// @access  Private
exports.unlockTemplate = async (req, res) => {
    const { templateId, cost } = req.body;

    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Check if already unlocked
        if (user.unlockedTemplates && user.unlockedTemplates.includes(templateId)) {
            return res.status(200).json({ success: true, message: 'Template already unlocked', credits: user.credits, unlockedTemplates: user.unlockedTemplates });
        }

        const costAmount = parseInt(cost, 10);
        // Check balance
        if (user.credits < costAmount) {
            return res.status(400).json({ message: 'Insufficient credits', error: 'INSUFFICIENT_CREDITS' });
        }

        // Deduct credits
        user.credits -= costAmount;

        // Add to unlocked
        if (!user.unlockedTemplates) {
            user.unlockedTemplates = [];
        }
        user.unlockedTemplates.push(templateId);

        await user.save();

        // Record Transaction
        await Transaction.create({
            userId: user.id,
            amount: -costAmount,
            type: 'usage',
            description: `Unlocked template: ${templateId}`,
            status: 'completed'
        });

        res.json({ success: true, credits: user.credits, unlockedTemplates: user.unlockedTemplates });

    } catch (error) {
        console.error('Unlock Template Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};
