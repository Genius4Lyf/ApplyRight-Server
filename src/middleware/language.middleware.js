// Resolves the app language for the request from the X-App-Language header.
// Always sets req.lang — defaults to "en" so existing clients (and any request
// without the header) behave exactly as before.
const SUPPORTED = ["en", "fr"];

module.exports = (req, res, next) => {
  const raw = String(req.headers["x-app-language"] || "").toLowerCase().slice(0, 2);
  req.lang = SUPPORTED.includes(raw) ? raw : "en";
  next();
};

module.exports.SUPPORTED = SUPPORTED;
