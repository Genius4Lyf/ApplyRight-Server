const express = require("express");
const router = express.Router();
const {
    getDashboardStats,
    getAllUsers,
    updateUserRole,
    deleteUser,
    getAllTransactions,
    getUserDetails,
    getSettings,
    updateSettings
} = require("../controllers/admin.controller");
const NotificationController = require("../controllers/notification.controller");
const { protect } = require("../middleware/auth.middleware");
const { admin } = require("../middleware/admin.middleware");

// All routes are protected and require admin role
router.use(protect);
// router.use(admin); // Applied individually where needed, or globally if all are admin-only

// Admin Only Routes
router.get("/stats", admin, getDashboardStats);
router.get("/users", admin, getAllUsers);
router.get("/transactions", admin, getAllTransactions);
router.get("/users/:id", admin, getUserDetails);
router.put("/users/:id/role", admin, updateUserRole);
router.delete("/users/:id", admin, deleteUser);

// Settings
router.get("/settings", admin, getSettings);
router.put("/settings", admin, updateSettings);

// Notifications (Admin Broadcast)
router.post("/notifications/broadcast", admin, NotificationController.broadcast);

module.exports = router;
