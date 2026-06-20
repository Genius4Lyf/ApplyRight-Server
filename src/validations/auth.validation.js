const { z } = require("zod");

const registerSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    phone: z.string().regex(/^\+[1-9]\d{1,14}$/, "Please enter a valid international phone number with country code (e.g., +12025551234)"),
    referralCode: z.string().optional(),
    // Self-serve agent signup: "agent" creates a CV-agent account. Zod strips
    // unknown keys, so this must be declared to reach the controller.
    accountType: z.enum(["user", "agent"]).optional(),
  }),
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(1, "Password is required"),
  }),
});

module.exports = {
  registerSchema,
  loginSchema,
};
