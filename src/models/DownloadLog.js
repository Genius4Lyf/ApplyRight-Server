const mongoose = require('mongoose');

const downloadLogSchema = new mongoose.Schema({
    templateId: {
        type: String,
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    applicationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Application'
    },
    draftId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'DraftCV'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('DownloadLog', downloadLogSchema);
