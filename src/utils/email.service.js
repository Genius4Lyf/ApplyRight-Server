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

// Money formatter for receipts. Naira has no decimals in our pricing; USD does.
const formatMoney = (amount, currency) => {
  if (currency === "USD") return `$${Number(amount).toFixed(2)}`;
  return `₦${Number(amount || 0).toLocaleString("en-NG")}`;
};

// Friendly date like "7 July 2026" for expiry/receipt dates.
const formatDate = (date) =>
  new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/**
 * Send a purchase receipt / confirmation after a Flutterwave payment is granted.
 * BEST-EFFORT: the caller (grantEntitlement) wraps this so a mail failure never
 * blocks or reverses the entitlement. Resolves to null (no throw) when Resend is
 * unconfigured so dev/test grants keep working without email set up.
 *
 * @param {object} p
 * @param {string} p.email        recipient
 * @param {string} [p.firstName]  for the greeting
 * @param {string} p.itemLabel    marketing name (catalog label)
 * @param {number} p.amount       charged amount in the paid currency
 * @param {string} p.currency     "NGN" | "USD"
 * @param {string} p.reference    our flwTxRef (shown as the receipt no.)
 * @param {Date}   p.date         payment date
 * @param {Date}   [p.expiresAt]  subscription expiry (subscriptions only)
 * @param {string[]} p.included   human-readable "what you got" bullet lines
 */
const sendPurchaseReceipt = async (p) => {
  if (!resend) return null; // email not configured — silently skip (best-effort)

  const { data, error } = await resend.emails.send({
    from: fromAddress,
    to: p.email,
    subject: `Your ApplyRight receipt — ${p.itemLabel}`,
    html: purchaseReceiptTemplate(p),
    text: purchaseReceiptText(p),
  });

  if (error) {
    throw new Error(`Resend send failed: ${error.message || JSON.stringify(error)}`);
  }

  return data;
};

// Brand tokens mirrored from the app (src/index.css)
const BRAND = {
  primary: "#0f172a", // Slate 900 (ink) — kept equal to `ink` by intent, not coupling
  ink: "#0f172a", // Slate 900
  darkPanel: "#070c17", // Current app dark canvas / navigation ground
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
  `${(process.env.FRONTEND_URL || "").replace(/\/$/, "")}/applyright-icon-white.png`;

// Shared table-based shell used by every transactional email. Inline styles only —
// Gmail/Outlook strip <style>, flexbox and SVG — hence tables + a hosted <img>
// logo. `content` is the per-email <tr> rows dropped between the brand lockup and
// the footer; `preheader` is the hidden preview snippet shown in the inbox list.
const renderShell = (content, preheader) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light only" />
  <title>ApplyRight</title>
</head>
<body style="margin:0; padding:0; background-color:${BRAND.canvas}; -webkit-font-smoothing:antialiased;">
  <!-- Preheader (hidden preview text) -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
    ${preheader}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.canvas};">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <!-- Card -->
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px; max-width:480px; background-color:${BRAND.surface}; border:1px solid ${BRAND.border}; border-radius:14px; box-shadow:0 1px 3px rgba(15,23,42,0.06); overflow:hidden;">

          <!-- Thin brand accent -->
          <tr><td style="height:3px; line-height:3px; font-size:3px; background-color:${BRAND.primary};">&nbsp;</td></tr>

          <!-- Brand lockup: mirrors the app's editorial navy navigation and white logo -->
          <tr>
            <td style="padding:28px 40px; background-color:${BRAND.darkPanel};">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;">
                    <img src="${LOGO_URL}" width="30" height="30" alt="ApplyRight" style="display:block; width:30px; height:30px; border:0; outline:none; text-decoration:none;" />
                  </td>
                  <td style="padding-left:9px; vertical-align:middle; font-family:Georgia,'Times New Roman',serif; font-size:20px; font-weight:700; letter-spacing:-0.4px; color:#ffffff;">ApplyRight</td>
                </tr>
              </table>
            </td>
          </tr>

          ${content}

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

const passwordResetTemplate = (otp) =>
  renderShell(
    `
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
`,
    `Your ApplyRight reset code is ${otp}. It expires in 10 minutes.`
  );

// One "what you got" bullet row for the receipt's included-items list.
const includedRow = (line) => `
                <tr>
                  <td style="padding:6px 0; vertical-align:top; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:14px; line-height:1.5; color:${BRAND.muted};">
                    <span style="color:${BRAND.primary}; font-weight:700;">&#10003;</span>&nbsp;&nbsp;${line}
                  </td>
                </tr>`;

// One label/value row inside the receipt summary box.
const summaryRow = (label, value, opts = {}) => `
                <tr>
                  <td style="padding:${opts.tight ? "6px" : "10px"} 0 ${opts.tight ? "6px" : "10px"}; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:13px; color:${BRAND.faint};${opts.border ? ` border-top:1px solid ${BRAND.border};` : ""}">
                    ${label}
                  </td>
                  <td align="right" style="padding:${opts.tight ? "6px" : "10px"} 0 ${opts.tight ? "6px" : "10px"}; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:${opts.strong ? "16px" : "13px"}; font-weight:${opts.strong ? "700" : "600"}; color:${opts.strong ? BRAND.ink : BRAND.muted};${opts.border ? ` border-top:1px solid ${BRAND.border};` : ""}">
                    ${value}
                  </td>
                </tr>`;

const purchaseReceiptTemplate = (p) => {
  const greetName = p.firstName ? `, ${p.firstName}` : "";
  const amountStr = formatMoney(p.amount, p.currency);
  const included = (p.included || []).map(includedRow).join("");

  return renderShell(
    `
          <!-- Heading -->
          <tr>
            <td style="padding:24px 40px 0; font-family:Georgia,'Times New Roman',serif; font-size:22px; font-weight:700; letter-spacing:-0.3px; color:${BRAND.ink};">
              Payment confirmed
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:12px 40px 0; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:1.65; color:${BRAND.muted};">
              Thanks${greetName} — your purchase of <strong style="color:${BRAND.ink};">${p.itemLabel}</strong> is complete and your account has been upgraded. Here's your receipt.
            </td>
          </tr>

          <!-- What you got -->
          ${
            included
              ? `<tr>
            <td style="padding:24px 40px 4px; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:11px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:${BRAND.faint};">
              What's included
            </td>
          </tr>
          <tr>
            <td style="padding:4px 40px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${included}
              </table>
            </td>
          </tr>`
              : ""
          }

          <!-- Receipt summary box -->
          <tr>
            <td style="padding:24px 40px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.canvas}; border:1px solid ${BRAND.border}; border-radius:12px;">
                <tr><td style="padding:6px 20px 6px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    ${summaryRow("Item", p.itemLabel, { tight: true })}
                    ${summaryRow("Receipt no.", p.reference, { tight: true })}
                    ${summaryRow("Date", formatDate(p.date), { tight: true })}
                    ${p.expiresAt ? summaryRow("Renews / expires", formatDate(p.expiresAt), { tight: true }) : ""}
                    ${summaryRow("Amount paid", amountStr, { strong: true, border: true })}
                  </table>
                </td></tr>
              </table>
            </td>
          </tr>

          <!-- Note -->
          <tr>
            <td style="padding:24px 40px 32px; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:13px; line-height:1.6; color:${BRAND.faint};">
              ${
                p.expiresAt
                  ? "This is a one-time purchase — it does not auto-renew. You'll keep access until the date above."
                  : "Keep this email as your proof of purchase."
              } Questions about your order? Just reply to this email.
            </td>
          </tr>
`,
    `Payment confirmed — ${p.itemLabel} (${amountStr}). Receipt inside.`
  );
};

// Plain-text fallback for clients that don't render HTML.
const purchaseReceiptText = (p) => {
  const lines = [
    `Payment confirmed — thanks for your purchase!`,
    ``,
    `Item: ${p.itemLabel}`,
    `Amount paid: ${formatMoney(p.amount, p.currency)}`,
    `Receipt no.: ${p.reference}`,
    `Date: ${formatDate(p.date)}`,
  ];
  if (p.expiresAt) lines.push(`Expires: ${formatDate(p.expiresAt)}`);
  if (p.included && p.included.length) {
    lines.push(``, `What's included:`);
    p.included.forEach((l) => lines.push(`  - ${l}`));
  }
  lines.push(``, `Questions? Just reply to this email.`, `— ApplyRight`);
  return lines.join("\n");
};

// ── Launch announcement ────────────────────────────────────────────────────────
//
// The one-time "we're live" mail to everyone who registered during the pre-launch
// campaign. English-only by design for v1: of 215 accounts, one has interfaceLang
// set to French, so a second translated template is not worth the surface area yet.
const launchAnnouncementTemplate = (p) => {
  const greeting = p.firstName ? `Hi ${p.firstName},` : "Hi,";
  const appUrl = process.env.FRONTEND_URL || "https://applyright.com.ng";
  return renderShell(
    `
    <tr><td style="padding:0 0 6px 0;font:700 22px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};">
      We're live.
    </td></tr>
    <tr><td style="padding:0 0 18px 0;font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted};">
      ${greeting}<br /><br />
      ApplyRight is open. Thanks for signing up early &mdash; your account is ready and
      your bonus credits are already on it.
    </td></tr>
    <tr><td style="padding:0 0 20px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.accentSoft};border-radius:10px;">
        <tr><td style="padding:14px 16px;font:600 15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.accentInk};">
          ${p.credits} credits are waiting in your account
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 0 24px 0;">
      <a href="${appUrl}/login" style="display:inline-block;background:${BRAND.ink};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:10px;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        Start building your CV
      </a>
    </td></tr>
    <tr><td style="padding:0;font:400 14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.faint};">
      Build a CV around the job you're going for, score your fit before you apply, and
      practise the interview out loud. Questions? Just reply to this email.
    </td></tr>`,
    "ApplyRight is live — your bonus credits are ready."
  );
};

const launchAnnouncementText = (p) =>
  [
    p.firstName ? `Hi ${p.firstName},` : "Hi,",
    "",
    "ApplyRight is live.",
    "",
    `Thanks for signing up early - your account is ready and ${p.credits} bonus credits are already on it.`,
    "",
    `Sign in: ${process.env.FRONTEND_URL || "https://applyright.com.ng"}/login`,
    "",
    "Questions? Just reply to this email.",
    "- ApplyRight",
  ].join("\n");

/**
 * Send the launch announcement to a BATCH of recipients in one Resend call.
 *
 * Resend's batch endpoint takes up to 100 messages per request, which is what makes a
 * 215-person send three calls instead of 215 — the default plan allows roughly 2
 * requests/second, so the naive loop would spend two minutes getting rate-limited.
 *
 * Returns { sent, error }. Never throws: the caller is mid-way through a bulk send and
 * has to be able to record which batches landed.
 *
 * @param {Array<{email:string, firstName?:string, credits:number}>} recipients max 100
 */
const sendLaunchAnnouncementBatch = async (recipients) => {
  if (!resend) return { sent: 0, error: "RESEND_API_KEY is not set" };
  if (!recipients || recipients.length === 0) return { sent: 0, error: null };

  try {
    const { error } = await resend.batch.send(
      recipients.map((r) => ({
        from: fromAddress,
        to: r.email,
        subject: "ApplyRight is live",
        html: launchAnnouncementTemplate(r),
        text: launchAnnouncementText(r),
      }))
    );
    if (error) return { sent: 0, error: error.message || String(error) };
    return { sent: recipients.length, error: null };
  } catch (err) {
    return { sent: 0, error: err.message };
  }
};

// Signup verification code. Same shell and same shape as the password-reset OTP —
// this is the identical interaction (six digits, ten minutes) and it should look
// identical in the inbox.
const verificationCodeTemplate = (code) =>
  renderShell(
    `
    <tr><td style="padding:0 0 6px 0;font:700 22px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink};">
      Confirm your email
    </td></tr>
    <tr><td style="padding:0 0 18px 0;font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted};">
      Enter this code to finish creating your ApplyRight account.
    </td></tr>
    <tr><td style="padding:0 0 18px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="background:${BRAND.canvas};border:1px solid ${BRAND.border};border-radius:10px;padding:14px 22px;font:700 30px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:0.22em;color:${BRAND.ink};">
          ${code}
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0;font:400 14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.faint};">
      The code expires in 10 minutes. If you did not try to sign up, you can ignore
      this email &mdash; no account has been created.
    </td></tr>`,
    `${code} is your ApplyRight verification code`
  );

/**
 * Send a signup verification code. THROWS when email is unconfigured, unlike the
 * best-effort receipt: a code that never arrives leaves someone unable to sign up at
 * all, so the caller has to know and say so rather than showing a code entry box for a
 * mail that is never coming.
 */
const sendVerificationCode = async (email, code) => {
  if (!resend) throw new Error("EMAIL_UNAVAILABLE: RESEND_API_KEY is not set");
  const { error } = await resend.emails.send({
    from: fromAddress,
    to: email,
    subject: `${code} is your ApplyRight verification code`,
    html: verificationCodeTemplate(code),
    text: `Your ApplyRight verification code is ${code}. It expires in 10 minutes.`,
  });
  if (error) throw new Error(error.message || String(error));
  return true;
};

// Whether mail can actually leave the building. Exposed so a bulk send can HARD-FAIL
// up front instead of silently no-opping its way through the whole user table (the
// client is null when RESEND_API_KEY is unset, and every send quietly returns null).
const isEmailConfigured = () => !!resend;

// The configured sender, so a caller can refuse to bulk-send from resend.dev.
const getFromAddress = () => fromAddress;

module.exports = {
  sendPasswordResetOTP,
  sendPurchaseReceipt,
  sendLaunchAnnouncementBatch,
  sendVerificationCode,
  isEmailConfigured,
  getFromAddress,
};
