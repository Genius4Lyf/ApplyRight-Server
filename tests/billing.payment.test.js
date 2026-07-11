// Must be set BEFORE requiring the app: dotenv (in config/env) does NOT override
// already-present process.env values, so this becomes env.FLW_SECRET_HASH.
process.env.FLW_SECRET_HASH = "test-secret-hash";

const request = require("supertest");
const app = require("../src/app");
const User = require("../src/models/User");
const Payment = require("../src/models/Payment");
const Transaction = require("../src/models/Transaction");
const SystemSettings = require("../src/models/SystemSettings");
const flutterwave = require("../src/services/flutterwave.service");
const { getItem } = require("../src/config/catalog");
const jwt = require("jsonwebtoken");

jest.mock("express-rate-limit", () => jest.fn(() => (req, res, next) => next()));
jest.mock("../src/models/User");
jest.mock("../src/models/Payment");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/SystemSettings");
jest.mock("../src/services/flutterwave.service");
jest.mock("jsonwebtoken");

const mockUserId = "60c72b2f9b1d8b2bad6e1a11";
const mockUser = { _id: mockUserId, id: mockUserId, email: "u@example.com", credits: 5 };
// Source the expected price from the catalog so these assertions can never go
// stale when the price changes (checkout stores this; the webhook/verify grant
// requires the verified amount to match it).
const WEEKLY_PRO_NGN = getItem("weekly_pro").amountNgn;

describe("Billing — Flutterwave payments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwt.verify.mockReturnValue({ id: mockUserId });
    // User.findById supports BOTH protect's .select() and the controllers' await.
    User.findById.mockReturnValue({
      select: jest.fn().mockResolvedValue(mockUser),
      then: (resolve) => resolve(mockUser),
    });
    User.updateOne.mockResolvedValue({ modifiedCount: 1 });
    SystemSettings.findOne.mockResolvedValue({ maintenanceMode: false });
  });

  describe("POST /api/billing/checkout", () => {
    it("creates a pending Payment at the catalog price and returns a link", async () => {
      Payment.create.mockResolvedValue({});
      flutterwave.buildCheckout.mockResolvedValue({ link: "https://pay.flutterwave/abc" });

      const res = await request(app)
        .post("/api/billing/checkout")
        .set("Authorization", "Bearer mock")
        .send({ planId: "weekly_pro" });

      expect(res.statusCode).toBe(200);
      expect(res.body.link).toBe("https://pay.flutterwave/abc");
      expect(Payment.create).toHaveBeenCalledWith(
        expect.objectContaining({ amountNgn: WEEKLY_PRO_NGN, planId: "weekly_pro", status: "pending" })
      );
    });

    it("rejects an unknown plan", async () => {
      const res = await request(app)
        .post("/api/billing/checkout")
        .set("Authorization", "Bearer mock")
        .send({ planId: "nope" });
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe("UNKNOWN_PLAN");
    });
  });

  describe("POST /api/billing/flutterwave-webhook", () => {
    it("rejects a bad verif-hash with 401", async () => {
      const res = await request(app)
        .post("/api/billing/flutterwave-webhook")
        .set("verif-hash", "wrong")
        .send({ data: { tx_ref: "AR-1", id: "123" } });
      expect(res.statusCode).toBe(401);
      expect(flutterwave.verifyTransaction).not.toHaveBeenCalled();
    });

    it("verifies, marks successful, and grants once on a valid webhook", async () => {
      const payment = {
        _id: "p1",
        userId: mockUserId,
        amountNgn: WEEKLY_PRO_NGN,
        flwTxRef: "AR-1",
        planId: "weekly_pro",
        purpose: "subscription",
        status: "pending",
        grantedAt: null,
        save: jest.fn().mockResolvedValue(true),
      };
      Payment.findOne.mockResolvedValue(payment);
      Payment.updateOne.mockResolvedValue({ modifiedCount: 1 }); // grant claim
      flutterwave.verifyTransaction.mockResolvedValue({
        status: "successful",
        amount: WEEKLY_PRO_NGN,
        currency: "NGN",
        txRef: "AR-1",
        id: "999",
        raw: {},
      });

      const res = await request(app)
        .post("/api/billing/flutterwave-webhook")
        .set("verif-hash", "test-secret-hash")
        .send({ data: { tx_ref: "AR-1", id: "999" } });

      expect(res.statusCode).toBe(200);
      expect(flutterwave.verifyTransaction).toHaveBeenCalledWith("999");
      expect(payment.status).toBe("successful");
      expect(payment.flwTransactionId).toBe("999");
      expect(payment.save).toHaveBeenCalled();
      expect(User.updateOne).toHaveBeenCalled(); // entitlement granted
    });

    it("no-ops when the payment was already settled", async () => {
      const payment = {
        _id: "p1",
        userId: mockUserId,
        amountNgn: WEEKLY_PRO_NGN,
        flwTxRef: "AR-1",
        status: "successful",
        grantedAt: new Date(),
        save: jest.fn(),
      };
      Payment.findOne.mockResolvedValue(payment);

      const res = await request(app)
        .post("/api/billing/flutterwave-webhook")
        .set("verif-hash", "test-secret-hash")
        .send({ data: { tx_ref: "AR-1", id: "999" } });

      expect(res.statusCode).toBe(200);
      expect(flutterwave.verifyTransaction).not.toHaveBeenCalled();
      expect(User.updateOne).not.toHaveBeenCalled();
    });

    it("marks failed and does not grant on an amount mismatch", async () => {
      const payment = {
        _id: "p1",
        userId: mockUserId,
        amountNgn: WEEKLY_PRO_NGN,
        flwTxRef: "AR-1",
        planId: "weekly_pro",
        purpose: "subscription",
        status: "pending",
        grantedAt: null,
        save: jest.fn().mockResolvedValue(true),
      };
      Payment.findOne.mockResolvedValue(payment);
      flutterwave.verifyTransaction.mockResolvedValue({
        status: "successful",
        amount: 100, // less than catalog price
        currency: "NGN",
        txRef: "AR-1",
        id: "999",
        raw: {},
      });

      const res = await request(app)
        .post("/api/billing/flutterwave-webhook")
        .set("verif-hash", "test-secret-hash")
        .send({ data: { tx_ref: "AR-1", id: "999" } });

      expect(res.statusCode).toBe(200);
      expect(payment.status).toBe("failed");
      expect(User.updateOne).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/billing/verify (redirect fallback)", () => {
    it("verifies and grants when the webhook hasn't landed", async () => {
      const payment = {
        _id: "p1",
        userId: mockUserId,
        amountNgn: WEEKLY_PRO_NGN,
        flwTxRef: "AR-1",
        planId: "weekly_pro",
        purpose: "subscription",
        status: "pending",
        grantedAt: null,
        save: jest.fn().mockResolvedValue(true),
      };
      Payment.findOne.mockResolvedValue(payment);
      Payment.updateOne.mockResolvedValue({ modifiedCount: 1 });
      flutterwave.verifyTransaction.mockResolvedValue({
        status: "successful",
        amount: WEEKLY_PRO_NGN,
        currency: "NGN",
        txRef: "AR-1",
        id: "999",
        raw: {},
      });

      const res = await request(app)
        .post("/api/billing/verify")
        .set("Authorization", "Bearer mock")
        .send({ txRef: "AR-1", transactionId: "999" });

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("successful");
      expect(User.updateOne).toHaveBeenCalled();
    });
  });
});
