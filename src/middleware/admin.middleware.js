const jwt = require("jsonwebtoken");
const User = require("../models/User");

const admin = (req, res, next) => {
    if (req.user && req.user.role === "admin") {
        next();
    } else {
        res.status(401).json({ success: false, message: "Not authorized as an admin" });
    }
};

module.exports = { admin };
