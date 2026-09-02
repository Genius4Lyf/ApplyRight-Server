const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const SettingsService = require("../services/settings.service");
const User = require("../models/User");

// @desc    Get system status (maintenance mode), and — if a token is attached —
//          whether THIS caller specifically bypasses it. Public: no `protect`,
//          so a logged-out visitor still gets a maintenance answer. The bypass
//          check mirrors maintenance.middleware.js exactly (same role/flag
//          test) so this can never tell a granted user "blocked" while the
//          actual gate would have let them through, or vice versa.
// @route   GET /api/system/status
// @access  Public
router.get("/status", async (req, res) => {
  try {
    const settings = await SettingsService.getSettings();
    const maintenance = settings?.features?.maintenanceMode || false;

    let bypass = false;
    const authHeader = req.headers.authorization;
    if (maintenance && authHeader && authHeader.startsWith("Bearer")) {
      try {
        const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select("role maintenanceAccess");
        bypass = !!user && (user.role === "admin" || user.maintenanceAccess === true);
      } catch {
        // Expired/invalid token — same as a guest for this purpose.
      }
    }

    res.status(200).json({
      success: true,
      maintenance,
      bypass,
      message: maintenance ? "System is under maintenance" : "System is operational",
    });
  } catch (error) {
    console.error("System Status Error:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
});

module.exports = router;
