const mongoose = require("mongoose");

// A pending email-verification code, held OUTSIDE the User collection because the whole
// point is that the account does not exist yet: the code is proved before anything is
// created, so a bot cannot mint an account it has no mailbox for.
//
// One record per email address (unique), upserted on each request so asking for a new
// code invalidates the previous one rather than leaving several valid at once.
const emailVerificationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // bcrypt, never the code itself — the same treatment the password-reset OTP gets.
    // A leaked database dump must not hand out live signup codes.
    codeHash: {
      type: String,
      required: true,
    },
    // TTL: Mongo deletes the document once this passes, so expired codes clean
    // themselves up and no sweeper job is needed. Deliberately EXTENDED on successful
    // verification (see verifyEmailCode) — otherwise the record could expire in the gap
    // between entering the code and finishing the signup form, and the account creation
    // would fail for someone who did everything right.
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
    // Wrong guesses. A 6-digit code is only 1-in-a-million per try, so it has to be
    // cheap to guess only ONCE — this caps the attempts before the code is burned.
    attempts: {
      type: Number,
      default: 0,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    // Single use: set when an account is actually created against this record, so the
    // same verified code cannot be replayed to register a second account.
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmailVerification", emailVerificationSchema);
