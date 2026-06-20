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

// Gate a route to CV-agent accounts only (the agent dashboard / client folders).
const agent = (req, res, next) => {
  if (req.user && req.user.role === "agent") {
    next();
  } else {
    res.status(401).json({ message: "Not authorized as an agent" });
  }
};

const TIER_RANK = { free: 0, plus: 1, pro: 2 };

// Gate a route on the user's EFFECTIVE tier (honors subscription expiry — an
// expired sub counts as free). 403s users below `min`, e.g. requireTier("plus").
const requireTier = (min) => (req, res, next) => {
  const { getEffectiveTier } = require("../services/subscription.service");
  const eff = getEffectiveTier(req.user);
  const userRank = TIER_RANK[eff] ?? 0;
  if (userRank >= (TIER_RANK[min] ?? 0)) return next();

  return res.status(403).json({
    message: `This feature requires the ${min} plan.`,
    code: "TIER_REQUIRED",
    requiredTier: min,
  });
};

module.exports = { protect, admin, agent, requireTier, TIER_RANK };
