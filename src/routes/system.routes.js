const express = require('express');
const router = express.Router();
const SettingsService = require('../services/settings.service');

// @desc    Get system status (maintenance mode)
// @route   GET /api/system/status
// @access  Public
router.get('/status', async (req, res) => {
    try {
        const settings = await SettingsService.getSettings();
        const maintenance = settings?.features?.maintenanceMode || false;

        res.status(200).json({
            success: true,
            maintenance,
            message: maintenance ? 'System is under maintenance' : 'System is operational'
        });
    } catch (error) {
        console.error("System Status Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

module.exports = router;
