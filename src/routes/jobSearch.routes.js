const express = require("express");
const router = express.Router();
const {
  searchJobs,
  getSearchResults,
  getTrendingJobs,
  browseJobs,
  getJobDetails,
  trackClick,
} = require("../controllers/jobSearch.controller");

// All job listing routes are public (no authentication required)
router.get("/trending", getTrendingJobs);
router.get("/browse", browseJobs);

router.post("/search", searchJobs);
router.get("/search/:searchId", getSearchResults);

router.post("/:searchId/details/:resultId", getJobDetails);
router.post("/:searchId/click/:resultId", trackClick);

module.exports = router;
