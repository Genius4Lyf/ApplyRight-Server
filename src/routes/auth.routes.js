const express = require("express");
const rateLimit = require("express-rate-limit");
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
  requestEmailVerification,
  verifyEmailCode,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const { registerSchema, loginSchema } = require("../validations/auth.validation");

// The library's own IPv6 normaliser (subnet, not address, so the last hextet cannot be
// rotated to reset a counter). Guarded because the suites mock express-rate-limit as a
// bare jest.fn with no named exports — under that mock the limiter is a pass-through and
// keyGenerator never runs.
const ipKeyOf = require("express-rate-limit").ipKeyGenerator || ((req) => req.ip);

// Stricter than the global 100/15min limiter: blunts registration spam,
// password-reset abuse, and brute-forcing the admin secret. Per IP.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again after 15 minutes." },
});

// Verification-code sends are the sharpest abuse surface on this API: each call puts
// mail in someone else's inbox and spends a slice of a 100/day quota that signups
// depend on. A real person needs two or three sends at most; an email-bombing script or
// a quota-burning bot needs many.
//
// KEYED ON THE EMAIL, NOT THE IP — the same defect, and the same fix, as the
// conversation limiter in middleware/rateLimit.middleware. Nigerian mobile networks run
// carrier-grade NAT, so thousands of subscribers share a handful of public addresses:
// per-IP, this was a budget of FIVE SIGNUPS PER HOUR FOR AN ENTIRE CARRIER, and the
// sixth stranger to try was told to come back later. On the signup form, which is the
// one page where a blocked user simply leaves.
//
// Keying on the address also matches what is actually being abused. The harm in this
// endpoint is mail landing in a specific inbox, and that inbox is named in the request.
const verificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Normalised the same way requestEmailVerification normalises it, or the same person
  // gets separate budgets for "A@x.com" and "a@x.com ".
  keyGenerator: (req, res) => {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    return email ? `verify:${email}` : ipKeyOf(req, res);
  },
  message: { message: "Too many verification codes requested. Please try again later." },
});

// The backstop the email key gives up: a script that rotates addresses has a fresh
// 5/hour budget for every one it invents, and each attempt spends a slice of the 100/day
// Resend quota that real signups depend on.
//
// So a per-IP ceiling stays — set where a carrier NAT full of genuine signups will never
// reach it, but an address-rotating bot will. Sixty an hour is roughly one signup a
// minute from a single public address: implausible for real users sharing a carrier,
// cheap to hit for a loop.
const verificationIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyOf(req, res),
  message: { message: "Too many verification codes requested. Please try again later." },
});

// Login: only FAILED attempts count, so normal log-in/out never trips it but
// credential stuffing / password guessing does.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many login attempts. Please try again after 15 minutes." },
});

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
// Signup verification. The code is proved BEFORE /register will create anything, so
// these two run first and /register refuses without them.
router.post(
  "/request-verification",
  verificationIpLimiter,
  verificationLimiter,
  requestEmailVerification
);
// Checking a code is cheap and sends no mail, so it gets the ordinary auth limiter —
// the per-code attempt cap in the controller is what stops brute force here.
router.post("/verify-code", authLimiter, verifyEmailCode);
router.post("/register", authLimiter, validate(registerSchema), registerUser);

router.post("/register-secret-admin", authLimiter, registerAdmin); // Obscured route name in verifying logic, but public endpoint needs to be known by frontend

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
router.post("/login", loginLimiter, validate(loginSchema), loginUser);

router.post("/forgotpassword", authLimiter, forgotPassword);
router.post("/resetpassword", authLimiter, resetPassword);
router.get("/me", protect, getMe);
router.put("/profile", protect, updateProfile);

module.exports = router;
