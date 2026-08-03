const geoip = require("geoip-lite");

// app.js sets `trust proxy 1`, so req.ip is already the real client IP on
// Render (behind one proxy hop). Node reports IPv4-mapped addresses as
// "::ffff:1.2.3.4" — strip that prefix so geoip-lite gets a plain IPv4.
const clientIp = (req) => {
  const ip = req.ip || "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
};

const isLoopbackOrPrivate = (ip) => {
  if (ip === "::1" || ip === "127.0.0.1") return true;
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // fc00::/7 unique local addresses (fc.. or fd..)
  if (/^f[cd][0-9a-f]{0,2}:/i.test(ip)) return true;
  return false;
};

// ISO-3166-1 alpha-2, or null. Never throws, never guesses — local/private
// IPs and lookup misses all resolve to null rather than a fabricated country.
const countryFromIp = (ip) => {
  if (!ip) return null;
  if (isLoopbackOrPrivate(ip)) return null;
  try {
    const result = geoip.lookup(ip);
    return result?.country || null;
  } catch {
    return null;
  }
};

// null is a distinct, load-bearing state (UNKNOWN) — it must never default to
// USD or NGN. Unknown gets the currency toggle; a confidently-resolved
// non-Nigerian country does not.
const currencyForCountry = (country) => {
  if (!country) return null;
  return country === "NG" ? "NGN" : "USD";
};

module.exports = { clientIp, countryFromIp, currencyForCountry };
