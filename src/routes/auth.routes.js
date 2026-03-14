const express = require("express");
const router = express.Router();
const {
  registerUser,
  loginUser,
  getMe,
  updateProfile,
  forgotPassword,
  resetPassword,
  registerAdmin,
  getConfig,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const { registerSchema, loginSchema } = require("../validations/auth.validation");

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User authentication and management
 */

router.get("/config", getConfig);

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       201:
 *         description: User registered successfully
 *       400:
 *         description: Validation error
 */
router.post("/register", validate(registerSchema), registerUser);

router.post("/register-secret-admin", registerAdmin); // Obscured route name in verifying logic, but public endpoint needs to be known by frontend

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post("/login", validate(loginSchema), loginUser);

router.post("/forgotpassword", forgotPassword);
router.post("/resetpassword", resetPassword);
router.get("/me", protect, getMe);
router.put("/profile", protect, updateProfile);

module.exports = router;

