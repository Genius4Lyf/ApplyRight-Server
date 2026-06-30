const { Resend } = require("resend");

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.RESEND_FROM_EMAIL || "ApplyRight <onboarding@resend.dev>";

// Lazily create the client so a missing key fails loudly only when we try to send,
// not at import time (keeps the rest of auth working in dev without Resend configured).
const resend = apiKey ? new Resend(apiKey) : null;

/**
 * Send a password-reset OTP code to the user's email.
 * Throws if Resend is not configured or the send fails, so the caller can
 * roll back the stored token and surface a 500.
 */
const sendPasswordResetOTP = async (email, otp) => {
  if (!resend) {
    throw new Error("EMAIL_UNAVAILABLE: RESEND_API_KEY is not set");
  }

  const { data, error } = await resend.emails.send({
    from: fromAddress,
    to: email,
    subject: "Your ApplyRight password reset code",
    html: passwordResetTemplate(otp),
    text: `Your ApplyRight password reset code is ${otp}. It expires in 10 minutes. If you didn't request this, you can safely ignore this email.`,
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message || JSON.stringify(error)}`);
  }

  return data;
};

const passwordResetTemplate = (otp) => `
  <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #0f172a;">
    <div style="text-align: center; margin-bottom: 24px;">
      <span style="font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">ApplyRight</span>
    </div>
    <h1 style="font-size: 18px; font-weight: 600; margin: 0 0 12px;">Reset your password</h1>
    <p style="font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 24px;">
      Use the code below to reset your password. This code expires in <strong>10 minutes</strong>.
    </p>
    <div style="text-align: center; margin: 0 0 24px;">
      <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 8px; background: #f1f5f9; border-radius: 10px; padding: 16px 24px; color: #4F46E5;">
        ${otp}
      </span>
    </div>
    <p style="font-size: 13px; line-height: 1.6; color: #94a3b8; margin: 0;">
      If you didn't request a password reset, you can safely ignore this email — your password won't change.
    </p>
    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
    <p style="font-size: 12px; color: #cbd5e1; text-align: center; margin: 0;">
      &copy; ${new Date().getFullYear()} ApplyRight. All rights reserved.
    </p>
  </div>
`;

module.exports = { sendPasswordResetOTP };
