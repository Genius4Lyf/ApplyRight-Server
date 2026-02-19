const SystemSettings = require('../models/SystemSettings');

const SettingsService = {
    // Get the singleton settings object
    getSettings: async () => {
        return await SystemSettings.getInstance();
    },

    // Update settings (partial updates allowed)
    updateSettings: async (updates) => {
        const settings = await SystemSettings.getInstance();

        // Deep merge logic (simplified for Mongoose)
        // We iterate over the keys to update
        Object.keys(updates).forEach(key => {
            if (typeof updates[key] === 'object' && updates[key] !== null && !Array.isArray(updates[key])) {
                // Nested object update (e.g. credits.signupBonus)
                if (!settings[key]) settings[key] = {};
                Object.assign(settings[key], updates[key]);
            } else {
                // Direct value update or array
                settings[key] = updates[key];
            }
        });

        await settings.save();
        return settings;
    },

    // Get a specific value (helper)
    get: async (path) => {
        const settings = await SystemSettings.getInstance();
        const keys = path.split('.');
        let value = settings;
        for (const key of keys) {
            value = value ? value[key] : undefined;
        }
        return value;
    }
};

module.exports = SettingsService;
