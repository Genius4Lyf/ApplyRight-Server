const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const {
  searchJobs,
  getSearchResults,
  getTrendingJobs,
  browseJobs,
  getRecommendations,
  getJobDetails,
  trackClick,
  toggleSave,
  getSavedJobs,
  tailorCV,
  tailorBundle,
  updateJobProfile,
} = require("../controllers/jobSearch.controller");

// Job profile / onboarding
router.put("/profile", protect, updateJobProfile);

// Trending & browse (no profile needed)
router.get("/trending", protect, getTrendingJobs);
router.get("/browse", protect, browseJobs);

// Search
router.post("/search", protect, searchJobs);
router.get("/search/:searchId", protect, getSearchResults);

// Recommendations (personalized — needs profile/CV)
router.get("/recommendations", protect, getRecommendations);

// Saved jobs
router.get("/saved", protect, getSavedJobs);

// Job details + actions (must come after named routes)
router.post("/:searchId/details/:resultId", protect, getJobDetails);
router.post("/:searchId/click/:resultId", protect, trackClick);
router.post("/:searchId/save/:resultId", protect, toggleSave);
router.post("/:searchId/tailor/:resultId", protect, tailorCV);
router.post("/:searchId/tailor-bundle/:resultId", protect, tailorBundle);

module.exports = router;
