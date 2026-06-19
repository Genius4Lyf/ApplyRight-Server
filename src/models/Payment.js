const mongoose = require("mongoose");

// Real MONEY (NGN), kept SEPARATE from the Transaction model. Transaction tracks
// credits (an internal currency) and its `amount` is aggregated into the admin
// credit charts — mixing Naira there would corrupt those charts. All revenue
// analytics read from Payment instead.
//
// Idempotency is two-layered (mirrors Transaction.externalTxId's sparse-unique idea):
//   - flwTxRef         : OUR reference, set at checkout. Unique => one Payment row
//                        per checkout attempt.
//   - flwTransactionId : Flutterwave's id, set after verification. Unique+sparse =>
//                        a redelivered webhook can't create/grant a second time.
//   - grantedAt        : second guard inside grantEntitlement (guarded updateOne).
const paymentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amountNgn: {
      type: Number,
      required: true, // taken from the catalog, NOT the client
    },
    currency: {
      type: String,
      default: "NGN",
    },
    // Our checkout reference (tx_ref sent to Flutterwave). Idempotency on create.
    flwTxRef: {
      type: String,
      required: true,
      unique: true,
    },
    // Flutterwave's transaction id, captured on successful verification.
    // Sparse so multiple pending payments (id still null) don't collide.
    flwTransactionId: {
      type: String,
      unique: true,
      sparse: true,
    },
    status: {
      type: String,
      enum: ["pending", "successful", "failed", "abandoned"],
      default: "pending",
      index: true,
    },
    purpose: {
      type: String,
      enum: ["subscription", "topup", "download"],
      required: true,
    },
    planId: {
      type: String,
      default: null,
    },
    tierGranted: {
      type: String,
      default: null,
    },
    minutesGranted: {
      type: Number,
      default: 0,
    },
    // Set once the entitlement has actually been applied to the user. Acts as the
    // final idempotency guard so a double webhook can't grant twice.
    grantedAt: {
      type: Date,
      default: null,
    },
    // Raw provider verification payload, for support/audit.
    raw: {
      type: Object,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Payment", paymentSchema);
