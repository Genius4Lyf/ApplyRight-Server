const express = require("express");
const router = express.Router();
const {
  saveDraft,
  getMyDrafts,
  listDrafts,
  getDraftById,
  deleteDraft,
} = require("../controllers/cv.controller");
const { protect } = require("../middleware/auth.middleware");

router.post("/save", protect, saveDraft);
router.get("/my-cvs", protect, getMyDrafts);
// Must stay ABOVE "/:id" — Express matches in order, and "list" would otherwise be
// swallowed as a draft id.
router.get("/list", protect, listDrafts);
router.get("/:id", protect, getDraftById);
router.delete("/:id", protect, deleteDraft);

module.exports = router;
