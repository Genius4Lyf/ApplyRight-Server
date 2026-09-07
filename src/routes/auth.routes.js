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
const { emailKeyOf, ipKeyOf } = require("../middleware/rateLimit.middleware");

// Blunts registration spam, password-reset abuse, and brute-forcing the admin secret.
//
// PER EMAIL, not per IP — the same correction already made for verification codes
// below, and for the same reason. Twenty registration or reset attempts in a quarter
// of an hour is absurd for one person and was the right number; counting them per IP
// meant twenty for an entire mobile carrier, on the signup form, which is the one
// page where a blocked stranger simply leaves and never comes back.
//
// Every route this guards carries the address it is acting on. /resetpassword is the
// exception (it carries a token instead), and emailKeyOf falls back to the IP there —
// which is the old behaviour, and fine: that route's real protection is the secret in
// the token, not a counter.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKeyOf("auth"),
  message: { message: "Too many attempts. Please try again after 15 minutes." },
});

// The backstop an email key gives up: a script that invents a new address every time
// gets a fresh 20 for each one. So a per-IP ceiling stays — set where a carrier full
// of genuine signups will not reach it, but a loop will, in seconds.
const authIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyOf,
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
  keyGenerator: emailKeyOf("verify"),
  message: { message: "Too many verification codes requested. Please try again later." },
});

// The backstop the email key gives up: a script that rotates addresses has a fresh
// 5/hour budget for every one it invents, and each attempt spends a slice of the 100/day
// Resend quota that real signups depend on.
//
// So a per-IP ceiling stays — but set where a carrier NAT full of genuine signups will
// never reach it, which 60/hour was not. On a launch day one carrier address can carry
// far more than a signup a minute, and this limiter would then have been the new
// version of the bug it was added to fix.
//
// 300/hour is a bot ceiling, not a user ceiling: a rotating-address script hits it in
// under a minute. It is also no longer the thing that breaks first — the Resend daily
// quota is, and that is a plan decision rather than a code one.
const verificationIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyOf,
  message: { message: "Too many verification codes requested. Please try again later." },
});

// Login: only FAILED attempts count, so normal log-in/out never trips it but
// credential stuffing / password guessing does.
//
// PER EMAIL. Ten wrong passwords is the right budget for one account — and it is the
// account that is under attack, so that is what should be locked. Per IP it was ten
// wrong passwords for a whole carrier: a handful of people fat-fingering their own
// password could shut everyone else out of the login page for fifteen minutes, and an
// attacker on a different network was unaffected by any of it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailKeyOf("login"),
  message: { message: "Too many login attempts. Please try again after 15 minutes." },
});

// And the backstop, again: stuffing a list of addresses gets 10 tries per address.
// This counts only failures, so a carrier full of people typing their own passwords
// correctly never touches it.
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKeyOf,
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
router.post("/verify-code", authIpLimiter, authLimiter, verifyEmailCode);
router.post("/register", authIpLimiter, authLimiter, validate(registerSchema), registerUser);

router.post("/register-secret-admin", authIpLimiter, authLimiter, registerAdmin); // Obscured route name in verifying logic, but public endpoint needs to be known by frontend

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
router.post("/login", loginIpLimiter, loginLimiter, validate(loginSchema), loginUser);

router.post("/forgotpassword", authIpLimiter, authLimiter, forgotPassword);
router.post("/resetpassword", authIpLimiter, authLimiter, resetPassword);
router.get("/me", protect, getMe);
router.put("/profile", protect, updateProfile);

module.exports = router;
