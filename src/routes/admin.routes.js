const express = require("express");
const router = express.Router();
const {
    getDashboardStats,
    getAllUsers,
    updateUserRole,
    deleteUser,
    getAllTransactions,
    getUserDetails,
} = require("../controllers/admin.controller");
const { protect } = require("../middleware/auth.middleware");
const { admin } = require("../middleware/admin.middleware");

// All routes are protected and require admin role
router.use(protect);
router.use(admin);

router.get("/stats", getDashboardStats);
router.get("/users", getAllUsers);
router.get("/transactions", getAllTransactions);
router.get("/users/:id", getUserDetails);
router.put("/users/:id/role", updateUserRole);
router.delete("/users/:id", deleteUser);

module.exports = router;
