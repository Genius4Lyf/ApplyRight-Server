// One definition of "this account gets in while the gate is up".
//
// The rule was written inline in three places — the global middleware, GET /system/status,
// and now the login response. Three copies of an access rule is how they drift, and a
// drift here is not cosmetic: it either tells a granted user they are blocked while every
// request of theirs would have succeeded, or shows them the app and then 503s everything.
const bypassesMaintenance = (user) =>
  !!user && (user.role === "admin" || user.maintenanceAccess === true);

// The projection the rule needs, so a caller cannot select too little and get a
// silently-false answer.
const BYPASS_FIELDS = "role maintenanceAccess";

module.exports = { bypassesMaintenance, BYPASS_FIELDS };
