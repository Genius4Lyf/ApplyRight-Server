const express = require("express");
const router = express.Router();
const { protect, agent } = require("../middleware/auth.middleware");
const {
  listClients,
  createClient,
  getClient,
  updateClient,
  deleteClient,
  getClientCVs,
  getSummary,
} = require("../controllers/agent.controller");

// All agent routes require an authenticated CV-agent account.
router.use(protect, agent);

router.get("/summary", getSummary);

router.route("/clients").get(listClients).post(createClient);
router.route("/clients/:id").get(getClient).patch(updateClient).delete(deleteClient);
router.get("/clients/:id/cvs", getClientCVs);

module.exports = router;
