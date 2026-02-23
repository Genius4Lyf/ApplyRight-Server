const mongoose = require('mongoose');

const systemSettingsSchema = new mongoose.Schema({
    credits: {
        signupBonus: { type: Number, default: 20 },
        referralBonus: { type: Number, default: 10 },
        analysisCost: { type: Number, default: 30 },
        uploadCost: { type: Number, default: 15 },
        aiSkillsCost: { type: Number, default: 10 },
        adReward: { type: Number, default: 5 }
    },
    features: {
        maintenanceMode: { type: Boolean, default: false },
        enablePdfGeneration: { type: Boolean, default: true },
        enableAiAnalysis: { type: Boolean, default: true }
    },
    announcement: {
        enabled: { type: Boolean, default: false },
        message: { type: String, default: "" },
        type: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' }
    },
    templates: {
        featuredTemplateId: { type: String, default: 'ats-clean' },
        disabledTemplateIds: [{ type: String }]
    },
    ai: {
        model: { type: String, default: 'gpt-3.5-turbo' },
        maxTokens: { type: Number, default: 2000 }
    }
}, {
    timestamps: true
});

// Enforce singleton pattern: only one doc should exist
systemSettingsSchema.statics.getInstance = async function () {
    const settings = await this.findOne();
    if (settings) return settings;
    return await this.create({});
};

module.exports = mongoose.model('SystemSettings', systemSettingsSchema);
