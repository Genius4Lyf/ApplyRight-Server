const DraftCV = require('../models/DraftCV');

// @desc    Save/Update a Draft CV
// @route   POST /api/cv/save
// @access  Private
const saveDraft = async (req, res) => {
    try {
        const { _id, ...data } = req.body;

        // If ID exists, update existing
        if (_id) {
            let draft = await DraftCV.findById(_id);

            if (!draft) {
                return res.status(404).json({ message: 'Draft not found' });
            }

            if (draft.userId.toString() !== req.user.id) {
                return res.status(401).json({ message: 'Not authorized' });
            }

            draft = await DraftCV.findByIdAndUpdate(_id, data, { new: true });
            return res.json(draft);
        }

        // Else create new
        const draft = await DraftCV.create({
            userId: req.user.id,
            source: 'scratch',
            ...data
        });

        res.status(201).json(draft);
    } catch (error) {
        console.error("Save Draft Error:", error);
        res.status(500).json({ message: 'Failed to save draft' });
    }
};

// @desc    Get all drafts for a user
// @route   GET /api/cv/my-cvs
// @access  Private
const getMyDrafts = async (req, res) => {
    try {
        const drafts = await DraftCV.find({ userId: req.user.id }).sort({ updatedAt: -1 });
        res.json(drafts);
    } catch (error) {
        console.error("Get Drafts Error:", error);
        res.status(500).json({ message: 'Failed to fetch drafts' });
    }
};

// @desc    Get single draft
// @route   GET /api/cv/:id
// @access  Private
const getDraftById = async (req, res) => {
    try {
        const draft = await DraftCV.findById(req.params.id);

        if (!draft) {
            return res.status(404).json({ message: 'Draft not found' });
        }

        if (draft.userId.toString() !== req.user.id) {
            return res.status(401).json({ message: 'Not authorized' });
        }

        res.json(draft);
    } catch (error) {
        console.error("Get Draft Error:", error);
        res.status(500).json({ message: 'Failed to fetch draft' });
    }
};

// @desc    Delete a draft CV
// @route   DELETE /api/cv/:id
// @access  Private
const deleteDraft = async (req, res) => {
    try {
        const draft = await DraftCV.findById(req.params.id);

        if (!draft) {
            return res.status(404).json({ message: 'Draft not found' });
        }

        if (draft.userId.toString() !== req.user.id) {
            return res.status(401).json({ message: 'Not authorized' });
        }

        await DraftCV.findByIdAndDelete(req.params.id);
        res.json({ message: 'Draft deleted successfully' });
    } catch (error) {
        console.error("Delete Draft Error:", error);
        res.status(500).json({ message: 'Failed to delete draft' });
    }
};

module.exports = {
    saveDraft,
    getMyDrafts,
    getDraftById,
    deleteDraft,
};
