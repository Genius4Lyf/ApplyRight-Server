const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    type: {
        type: String,
        enum: ['purchase', 'usage', 'bonus', 'ad_reward', 'referral_reward'],
        required: true
    },
    description: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed'],
        default: 'completed'
    },
    reference: { // For payment gateway reference or internal ID
        type: String
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Transaction', transactionSchema);
