const SettingsService = require('../services/settings.service');
const User = require('../models/User');

const checkMaintenanceMode = async (req, res, next) => {
    try {
        const settings = await SettingsService.getSettings();

        if (settings && settings.features && settings.features.maintenanceMode) {
            // Maintenance is ON
            // Check if user is admin (if authenticated)
            // Note: This middleware runs AFTER auth middleware usually, or independently.
            // If it runs BEFORE auth, we can't know if they are admin unless we decode token here or skip for login routes.

            // Strategy:
            // 1. Allow login/auth routes always (so admins can log in)
            // 2. Allow admin routes always
            // 3. Block everything else

            // Bypass for Auth routes
            if (req.path.startsWith('/api/auth') || req.path.startsWith('/api/v1/auth')) {
                return next();
            }

            // Bypass for Admin routes (API)
            if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/v1/admin')) {
                return next();
            }

            // Bypass for System Status (Public)
            if (req.path.startsWith('/api/system') || req.path.startsWith('/api/v1/system')) {
                return next();
            }

            // For other routes, STRICTLY check if user is admin
            // If req.user is already populated by 'protect' middleware, use it.
            if (req.user && req.user.role === 'admin') {
                return next();
            }

            // If not authenticated yet but might be admin, we have a problem.
            // But typically, non-auth routes (public) should be blocked too.
            // And auth routes (dashboard data) should be blocked for non-admins.

            // So:
            // - If user IS logged in (req.user exists) and is NOT admin -> BLOCK
            // - If user is NOT logged in (guest) -> BLOCK (unless it's the login endpoint, handled above)

            return res.status(503).json({
                success: false,
                message: 'Service Temporarily Unavailable - Maintenance Mode',
                maintenance: true
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
