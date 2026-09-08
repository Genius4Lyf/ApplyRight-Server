const SettingsService = require("../services/settings.service");

/**
 * Gate a router behind one of `SystemSettings.features.*`.
 *
 * The admin panel has had a "Job Search" toggle for a long time, and `enableJobSearch`
 * has been in the schema for just as long — READ BY NOTHING. Flipping it did nothing at
 * all, which is the same shape as the free-templates promo that was set in admin and
 * silently ignored by the download page.
 *
 * That matters more than an unused checkbox here, because `/api/job-search` is public and
 * unauthenticated: anything that finds those URLs — a crawler, a scanner, somebody
 * poking — makes this server scrape Jobberman from our IP, for a feature no page in the
 * app even links to. The toggle should be able to stop that, and now it can.
 *
 * FAILS CLOSED, unlike the maintenance gate above it, which fails open to avoid locking
 * people out on a database blip. The trade runs the other way here: the cost of wrongly
 * blocking is an unlinked page returning 503, and the cost of wrongly allowing is us
 * scraping someone else's site because a settings read timed out. Nobody is locked out of
 * anything by this.
 */
const requireFeature = (featureKey) => async (req, res, next) => {
  try {
    const settings = await SettingsService.getSettings();
    if (settings?.features?.[featureKey] === true) return next();
  } catch (error) {
    console.error(`Feature gate (${featureKey}) settings read failed:`, error.message);
  }

  // A CODE rather than a bare 404: "off" should read as off in the logs, not as a routing
  // bug somebody spends an afternoon on.
  return res.status(503).json({
    code: "FEATURE_DISABLED",
    feature: featureKey,
    message: "This feature is currently switched off.",
  });
};

module.exports = { requireFeature };
