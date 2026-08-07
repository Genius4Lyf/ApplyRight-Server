const mongoose = require("mongoose");
const {
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUS_VALUES,
} = require("../config/transactionTypes");

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
      enum: TRANSACTION_TYPE_VALUES,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: TRANSACTION_STATUS_VALUES,
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
