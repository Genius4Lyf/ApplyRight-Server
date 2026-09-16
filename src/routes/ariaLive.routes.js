const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const ariaLiveController = require("../controllers/ariaLive.controller");

// Deliberately NOT requireTier, matching the live-interview route: the gate is the minute
// BALANCE, checked in the controller, so a free user can spend their first-role taste and a
// paid user with no Aria minutes is stopped just the same. Tier is the wrong question here.
router.post("/session", protect, ariaLiveController.createAriaLiveSession);

// Settles a finished call straight away so the balance in the sidebar is right before the
// user looks at it. The server's sideband settles it regardless — this is a courtesy, not
// the source of truth, and both paths share one idempotent settle.
router.post("/end", protect, ariaLiveController.endAriaLiveSession);

module.exports = router;
