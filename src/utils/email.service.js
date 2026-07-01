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

// Brand tokens mirrored from the app (src/index.css)
const BRAND = {
  primary: "#4f46e5", // Indigo 600
  primaryDark: "#4338ca", // Indigo 700 (gradient depth)
  ink: "#0f172a", // Slate 900
  darkPanel: "#020617", // Slate 950 — the AuthShell dark sidebar
  accent: "#f59e0b", // Amber 500
  accentSoft: "#fffbeb", // Amber 50
  accentInk: "#b45309", // Amber 700
  canvas: "#f8fafc", // Slate 50
  surface: "#ffffff",
  border: "#e2e8f0", // Slate 200
  muted: "#475569", // Slate 600
  faint: "#94a3b8", // Slate 400
};

// The real ApplyRight mark (public/applyright-icon.png — the same file the app's
// Navbar/AuthShell import). Email clients can't use bundled assets, so we point at
// the hosted copy served from the frontend root. Override with EMAIL_LOGO_URL if the
// asset ever moves to a CDN.
const LOGO_URL =
  process.env.EMAIL_LOGO_URL ||
  `${(process.env.FRONTEND_URL || "").replace(/\/$/, "")}/applyright-icon.png`;

// Table-based layout with inline styles for cross-client compatibility
// (Gmail/Outlook strip <style>, flexbox and SVG — hence tables + a Unicode
// sparkle glyph instead of the lucide icon used in the app).
const passwordResetTemplate = (otp) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light only" />
  <title>Reset your ApplyRight password</title>
</head>
<body style="margin:0; padding:0; background-color:${BRAND.canvas}; -webkit-font-smoothing:antialiased;">
  <!-- Preheader (hidden preview text) -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
    Your ApplyRight reset code is ${otp}. It expires in 10 minutes.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.canvas};">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Card -->
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px; max-width:480px; background-color:${BRAND.surface}; border:1px solid ${BRAND.border}; border-radius:14px; box-shadow:0 1px 3px rgba(15,23,42,0.06); overflow:hidden;">

          <!-- Thin brand accent -->
          <tr><td style="height:3px; line-height:3px; font-size:3px; background-color:${BRAND.primary};">&nbsp;</td></tr>

          <!-- Brand lockup -->
          <tr>
            <td style="padding:32px 40px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${LOGO_URL}" width="30" height="30" alt="ApplyRight" style="display:block; width:30px; height:30px; border:0; outline:none; text-decoration:none;" />
                  </td>
                  <td style="padding-left:9px; vertical-align:middle; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:19px; font-weight:700; letter-spacing:-0.4px; color:${BRAND.ink};">ApplyRight</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Heading -->
          <tr>
            <td style="padding:24px 40px 0; font-family:Georgia,'Times New Roman',serif; font-size:22px; font-weight:700; letter-spacing:-0.3px; color:${BRAND.ink};">
              Reset your password
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:12px 40px 0; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:1.65; color:${BRAND.muted};">
              We received a request to reset your ApplyRight password. Enter the code below to choose a new one. It expires in 10 minutes.
            </td>
          </tr>

          <!-- Code label -->
          <tr>
            <td style="padding:28px 40px 8px; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:${BRAND.faint};">
              Your reset code
            </td>
          </tr>

          <!-- OTP chip -->
          <tr>
            <td style="padding:0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:${BRAND.canvas}; border:1px solid ${BRAND.border}; border-radius:12px; padding:22px 16px; font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace; font-size:34px; font-weight:700; letter-spacing:12px; text-indent:12px; color:${BRAND.ink};">
                    ${otp}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Security note -->
          <tr>
            <td style="padding:24px 40px 32px; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:13px; line-height:1.6; color:${BRAND.faint};">
              Keep this code private — ApplyRight will never ask you for it. If you didn't request a reset, you can safely ignore this email; your password won't change.
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:22px 40px; border-top:1px solid ${BRAND.border}; background-color:${BRAND.canvas}; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; text-align:center;">
              <div style="font-size:12px; color:${BRAND.muted}; margin-bottom:4px;">Land the job. Apply right.</div>
              <div style="font-size:11px; color:${BRAND.faint};">&copy; ${new Date().getFullYear()} ApplyRight. All rights reserved.</div>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>
</body>
</html>
`;

module.exports = { sendPasswordResetOTP };
