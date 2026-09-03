const jwt = require("jsonwebtoken");
const SettingsService = require("../services/settings.service");
const User = require("../models/User");

const checkMaintenanceMode = async (req, res, next) => {
  try {
    const settings = await SettingsService.getSettings();

    if (settings && settings.features && settings.features.maintenanceMode) {
      // Bypass for Auth routes (so people can still log in / register — see below)
      // and Admin routes (so the toggle can be flipped back off).
      if (req.path.startsWith("/api/auth") || req.path.startsWith("/api/v1/auth")) {
        return next();
      }
      if (req.path.startsWith("/api/admin") || req.path.startsWith("/api/v1/admin")) {
        return next();
      }
      if (req.path.startsWith("/api/system") || req.path.startsWith("/api/v1/system")) {
        return next();
      }

      // This runs BEFORE any route's own `protect` middleware — checkMaintenanceMode
      // is mounted globally in app.js ahead of every route mount, and `protect` is
      // only ever applied per-route inside route files. So `req.user` does not exist
      // yet here; the admin bypass below used to test for it and could never pass.
      // Decoding the token independently is what makes an admin (or an
      // admin-granted account, see User.maintenanceAccess) actually get through.
      let user = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer")) {
        try {
          const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
          user = await User.findById(decoded.id).select("role maintenanceAccess onboardingCompleted");
        } catch {
          // Expired/invalid token: fall through as a guest, same as `protect` would
          // 401 on a real request — but this middleware's job is only to decide
          // bypass-or-block, not to authenticate, so it degrades quietly.
        }
      }

      if (user && (user.role === "admin" || user.maintenanceAccess === true)) {
        return next();
      }

      // A pre-launch registrant still has to finish onboarding — it is the one thing
      // the campaign asks of them between signing up and the countdown, and its save
      // would otherwise 503 like everything else.
      //
      // Scoped as narrowly as it can be: ONLY while the launch campaign is running
      // (a genuine outage keeps its ordinary meaning, where nothing is writable),
      // only the onboarding save itself, only for an authenticated account, and only
      // while that account has not already completed it. The hole closes the moment
      // they finish, so it cannot become a general write channel through the gate.
      const isOnboardingSave =
        req.method === "PUT" &&
        (req.path === "/api/users/profile" || req.path === "/api/v1/users/profile");
      if (
        settings.launch?.enabled === true &&
        user &&
        user.onboardingCompleted !== true &&
        isOnboardingSave
      ) {
        return next();
      }

      return res.status(503).json({
        success: false,
        message: "Service Temporarily Unavailable - Maintenance Mode",
        maintenance: true,
      });
    }

    next();
  } catch (error) {
    console.error("Maintenance Check Error:", error);
    // Fail open or closed? Fail open for now to avoid accidental lockouts on db error
    next();
  }
};

module.exports = checkMaintenanceMode;
