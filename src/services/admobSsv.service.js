const crypto = require("crypto");
const https = require("https");
const env = require("../config/env");
const logger = require("../utils/logger");

const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let keyCache = { fetchedAt: 0, byKeyId: new Map() };

const fetchJson = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Verifier keys HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (err) {
            reject(new Error(`Verifier keys JSON parse failed: ${err.message}`));
          }
        });
      })
      .on("error", reject);
  });

const loadKeys = async (force = false) => {
  const now = Date.now();
  if (!force && now - keyCache.fetchedAt < KEY_CACHE_TTL_MS && keyCache.byKeyId.size > 0) {
    return keyCache.byKeyId;
  }
  const data = await fetchJson(env.ADMOB_SSV_KEYS_URL);
  const map = new Map();
  // Google returns { keys: [ { keyId, pem, base64, ... }, ... ] }
  (data.keys || []).forEach((k) => {
    if (k.keyId != null && k.pem) {
      map.set(String(k.keyId), k.pem);
    }
  });
  if (map.size === 0) {
    throw new Error("Verifier keys response contained no usable keys");
  }
  keyCache = { fetchedAt: now, byKeyId: map };
  return map;
};

/**
 * Verify the signature on a raw AdMob SSV query string per Google's spec:
 * https://developers.google.com/admob/android/ssv
 *
 * The query string is signed by Google up to (but not including) the
 * trailing `&signature=...&key_id=...` segment. We must use the raw query
 * as Google sent it — re-encoding via URLSearchParams will break the sig.
 *
 * @param {string} rawQs — req.originalUrl.split('?')[1]
 * @returns {Promise<{valid:boolean, reason?:string, params?:URLSearchParams}>}
 */
exports.verifySignature = async (rawQs) => {
  if (!rawQs || typeof rawQs !== "string") {
    return { valid: false, reason: "empty_query" };
  }

  const sigIdx = rawQs.indexOf("&signature=");
  if (sigIdx < 0) return { valid: false, reason: "no_signature" };
  const keyIdIdx = rawQs.indexOf("&key_id=", sigIdx);
  if (keyIdIdx < 0) return { valid: false, reason: "no_key_id" };

  const message = rawQs.slice(0, sigIdx);
  const signatureB64 = decodeURIComponent(rawQs.slice(sigIdx + "&signature=".length, keyIdIdx));
  const keyId = decodeURIComponent(rawQs.slice(keyIdIdx + "&key_id=".length));

  // Google uses URL-safe base64 (no padding) for the signature param
  const normalizedB64 = signatureB64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalizedB64 + "=".repeat((4 - (normalizedB64.length % 4)) % 4);
  let signatureBuf;
  try {
    signatureBuf = Buffer.from(padded, "base64");
  } catch (err) {
    return { valid: false, reason: "bad_signature_encoding" };
  }

  let keys = await loadKeys(false);
  let pem = keys.get(String(keyId));
  if (!pem) {
    // Force-refresh once in case Google rotated keys
    keys = await loadKeys(true);
    pem = keys.get(String(keyId));
    if (!pem) {
      return { valid: false, reason: "unknown_key_id" };
    }
  }

  const verifier = crypto.createVerify("SHA256");
  verifier.update(message);
  verifier.end();

  let valid;
  try {
    valid = verifier.verify(pem, signatureBuf);
  } catch (err) {
    logger.warn(`SSV verify exception: ${err.message}`);
    return { valid: false, reason: "verify_exception" };
  }

  if (!valid) return { valid: false, reason: "signature_mismatch" };

  // Parse the validated payload for the caller
  const params = new URLSearchParams(message);
  return { valid: true, params };
};

// Exposed for tests
exports._resetCacheForTest = () => {
  keyCache = { fetchedAt: 0, byKeyId: new Map() };
};
