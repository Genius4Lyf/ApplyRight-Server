// Flutterwave integration — one-time payments only (no Payment Plans / card-on-file).
// We use the hosted Standard checkout: create a payment, send the user to the
// returned link, then verify server-side (webhook + redirect fallback both call
// verifyTransaction). Audio/secret-style data never logged.
//
// SECURITY: never log FLUTTERWAVE_SECRET_KEY or full customer payloads.
const axios = require("axios");

class FlutterwaveUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlutterwaveUnavailableError";
    this.code = "FLW_UNAVAILABLE";
  }
}

const baseUrl = () => process.env.FLUTTERWAVE_BASE_URL || "https://api.flutterwave.com/v3";

const authHeaders = () => {
  const key = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!key) throw new FlutterwaveUnavailableError("FLUTTERWAVE_SECRET_KEY not configured");
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
};

/**
 * Create a hosted checkout and return the payment link the user is redirected to.
 * @param {{ user, item, txRef, redirectUrl }} args
 * @returns {Promise<{ link: string }>}
 */
const buildCheckout = async ({ user, item, txRef, redirectUrl, currency = "NGN" }) => {
  const isUsd = currency === "USD";
  const body = {
    tx_ref: txRef,
    amount: isUsd ? item.amountUsd : item.amountNgn,
    currency: isUsd ? "USD" : "NGN",
    redirect_url: redirectUrl,
    customer: {
      email: user.email,
      phonenumber: user.phone || undefined,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
    },
    customizations: {
      title: "ApplyRight",
      description: item.label,
    },
    meta: { userId: String(user._id), planId: item.id, purpose: item.purpose },
  };

  let data;
  try {
    const res = await axios.post(`${baseUrl()}/payments`, body, {
      headers: authHeaders(),
      timeout: 15000,
    });
    data = res.data;
  } catch (err) {
    // Do NOT surface the provider error body — it can echo request data.
    throw new FlutterwaveUnavailableError("Failed to create payment");
  }

  const link = data?.data?.link;
  if (data?.status !== "success" || !link) {
    throw new FlutterwaveUnavailableError("No payment link returned");
  }
  return { link };
};

/**
 * Server-side verification of a transaction by Flutterwave's id. Used by BOTH the
 * webhook and the redirect fallback — the single trusted source of truth for
 * whether money actually moved. Returns the normalized verification data.
 * @param {string|number} transactionId
 * @returns {Promise<{ status, amount, currency, txRef, id, customer, raw }>}
 */
const verifyTransaction = async (transactionId) => {
  if (!transactionId && transactionId !== 0) {
    throw new FlutterwaveUnavailableError("Missing transaction id");
  }
  let data;
  try {
    const res = await axios.get(
      `${baseUrl()}/transactions/${encodeURIComponent(transactionId)}/verify`,
      { headers: authHeaders(), timeout: 15000 }
    );
    data = res.data;
  } catch (err) {
    throw new FlutterwaveUnavailableError("Failed to verify transaction");
  }

  const d = data?.data || {};
  return {
    status: d.status, // "successful" | "failed" | ...
    amount: Number(d.amount),
    currency: d.currency,
    txRef: d.tx_ref,
    id: d.id != null ? String(d.id) : null,
    customer: d.customer || {},
    raw: d,
  };
};

module.exports = { buildCheckout, verifyTransaction, FlutterwaveUnavailableError };
