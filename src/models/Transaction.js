const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      enum: ["purchase", "usage", "ad_reward", "streak_bonus", "daily_login", "referral_bonus", "cv_tailor", "tailor_bundle"],
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "completed",
    },
    // AdMob SSV transaction_id (or other external idempotency key).
    // Unique sparse index prevents double-credit on Google retries.
    externalTxId: {
      type: String,
      unique: true,
      sparse: true,
    },
    rejectedReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Transaction", transactionSchema);
