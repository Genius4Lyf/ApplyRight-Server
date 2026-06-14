const jwt = require("jsonwebtoken");
const User = require("../models/User");

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      req.user = await User.findById(decoded.id).select("-password");
      return next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ message: "Not authorized, token failed" });
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }
};

const admin = (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(401).json({ message: "Not authorized as an admin" });
  }
};

const TIER_RANK = { free: 0, plus: 1, pro: 2 };

// While premium features are free during testing, this gate is a no-op (flip
// TIERS_FREE_DURING_TESTING to false in env to enforce). When enforced, it 403s
// users whose tier is below `min` so a route can be locked with requireTier("plus").
const requireTier = (min) => (req, res, next) => {
  const freeDuringTesting = process.env.TIERS_FREE_DURING_TESTING !== "false";
  if (freeDuringTesting) return next();

  const userRank = TIER_RANK[req.user?.tier] ?? 0;
  if (userRank >= (TIER_RANK[min] ?? 0)) return next();

  return res.status(403).json({
    message: `This feature requires the ${min} plan.`,
    code: "TIER_REQUIRED",
    requiredTier: min,
  });
};

module.exports = { protect, admin, requireTier, TIER_RANK };
