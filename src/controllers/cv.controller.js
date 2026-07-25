const DraftCV = require("../models/DraftCV");
const { isPaidActive } = require("../services/subscription.service");

// Accepted values for DraftCV.outputLang. `null` stays allowed implicitly by
// simply never being set — see the guard in saveDraft.
const OUTPUT_LANGS = ["en", "fr"];

// @desc    Save/Update a Draft CV
// @route   POST /api/cv/save
// @access  Private
const saveDraft = async (req, res) => {
  try {
    const { _id, ...data } = req.body;

    // Mark complete when reaching finalize step
    if (data.currentStep === "finalize") {
      data.isComplete = true;
    }

    // outputLang (the language the CV DOCUMENT is written in). Same enum-guard
    // style as interfaceLang: an unrecognised value is dropped rather than
    // failing the whole save, so a bad client can't wedge the user's CV. Note
    // findByIdAndUpdate doesn't run validators, so this guard is the only check.
    if ("outputLang" in data && !OUTPUT_LANGS.includes(data.outputLang)) {
      delete data.outputLang;
    }

    // If ID exists, update existing
    if (_id) {
      let draft = await DraftCV.findById(_id);

      if (!draft) {
        return res.status(404).json({ message: "Draft not found" });
      }

      if (draft.userId.toString() !== req.user.id) {
        return res.status(401).json({ message: "Not authorized" });
      }

      draft = await DraftCV.findByIdAndUpdate(_id, data, { new: true });
      return res.json(draft);
    }

    // CV agents must hold an active (agent) subscription to create new CVs —
    // the agent product is a paid CV factory. Editing existing CVs is unaffected
    // (only the create branch is gated). Job seekers are never gated here.
    if (req.user.role === "agent" && !isPaidActive(req.user)) {
      return res.status(402).json({
        message: "An active agent plan is required to create CVs.",
        code: "NEED_AGENT_SUB",
      });
    }

    // Else create new. A new CV inherits the creator's app language as its
    // DOCUMENT language, so a French user's new CVs default to French output
    // without them having to find the per-CV toggle. An explicit outputLang in
    // the payload still wins. Falls back to the request language when the user
    // record has none (older accounts predate interfaceLang).
    const draft = await DraftCV.create({
      userId: req.user.id,
      source: "scratch",
      outputLang: OUTPUT_LANGS.includes(req.user.interfaceLang)
        ? req.user.interfaceLang
        : req.lang,
      ...data,
    });

    res.status(201).json(draft);
  } catch (error) {
    console.error("Save Draft Error:", error);
    res.status(500).json({ message: "Failed to save draft" });
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
    res.status(500).json({ message: "Failed to fetch drafts" });
  }
};

// @desc    Get single draft
// @route   GET /api/cv/:id
// @access  Private
const getDraftById = async (req, res) => {
  try {
    const draft = await DraftCV.findById(req.params.id);

    if (!draft) {
      return res.status(404).json({ message: "Draft not found" });
    }

    if (draft.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "Not authorized" });
    }

    res.json(draft);
  } catch (error) {
    console.error("Get Draft Error:", error);
    res.status(500).json({ message: "Failed to fetch draft" });
  }
};

// @desc    Delete a draft CV
// @route   DELETE /api/cv/:id
// @access  Private
const deleteDraft = async (req, res) => {
  try {
    const draft = await DraftCV.findById(req.params.id);

    if (!draft) {
      return res.status(404).json({ message: "Draft not found" });
    }

    if (draft.userId.toString() !== req.user.id) {
      return res.status(401).json({ message: "Not authorized" });
    }

    await DraftCV.findByIdAndDelete(req.params.id);
    res.json({ message: "Draft deleted successfully" });
  } catch (error) {
    console.error("Delete Draft Error:", error);
    res.status(500).json({ message: "Failed to delete draft" });
  }
};

module.exports = {
  saveDraft,
  getMyDrafts,
  getDraftById,
  deleteDraft,
};
