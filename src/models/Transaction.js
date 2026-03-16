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
    reference: {
      type: String, // Paystack Reference
      unique: true,
      sparse: true,
    },
    paymentGateway: {
      type: String, // 'paystack'
      default: null,
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
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Transaction", transactionSchema);
