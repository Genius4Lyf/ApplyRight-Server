// Unit tests for the entitlement engine. Models are mocked; the catalog is real.
jest.mock("../src/models/User");
jest.mock("../src/models/Transaction");
jest.mock("../src/models/Payment");

const User = require("../src/models/User");
const Payment = require("../src/models/Payment");
const Transaction = require("../src/models/Transaction");
const subscription = require("../src/services/subscription.service");

describe("subscription.service", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("getEffectiveTier", () => {
    it("is free with no subscription", () => {
      expect(subscription.getEffectiveTier({})).toBe("free");
    });
    it("is free when the subscription has expired", () => {
      const past = new Date(Date.now() - 1000);
      expect(
        subscription.getEffectiveTier({ subscription: { tier: "pro", expiresAt: past } })
      ).toBe("free");
    });
    it("returns the tier while active", () => {
      const future = new Date(Date.now() + 100000);
      expect(
        subscription.getEffectiveTier({ subscription: { tier: "plus", expiresAt: future } })
      ).toBe("plus");
    });
  });

  // The API returns the client's EFFECTIVE paid status as
  //   plan: hasPaidAccess(user) ? "paid" : "free"
  // (auth login/register/profile + /auth/me, billing entitlement snapshot).
  describe("hasPaidAccess → effective client plan", () => {
    const effectivePlan = (user) => (subscription.hasPaidAccess(user) ? "paid" : "free");

    it('maps an EXPIRED subscription to "free"', () => {
      const past = new Date(Date.now() - 1000);
      const user = { plan: "paid", subscription: { tier: "pro", expiresAt: past } };
      expect(subscription.hasPaidAccess(user)).toBe(false);
      expect(effectivePlan(user)).toBe("free");
    });

    it('maps an ACTIVE subscription to "paid"', () => {
      const future = new Date(Date.now() + 100000);
      const user = { plan: "free", subscription: { tier: "plus", expiresAt: future } };
      expect(subscription.hasPaidAccess(user)).toBe(true);
      expect(effectivePlan(user)).toBe("paid");
    });

    it('maps an admin-granted tester (plan:"paid", no subscription) to "paid"', () => {
      const user = { plan: "paid" };
      expect(subscription.hasPaidAccess(user)).toBe(true);
      expect(effectivePlan(user)).toBe("paid");
    });

    it('maps a plain free user to "free"', () => {
      expect(effectivePlan({ plan: "free" })).toBe("free");
      expect(effectivePlan({})).toBe("free");
    });
  });

  describe("modelForUser", () => {
    it("uses the full model for an active pro tier", () => {
      const future = new Date(Date.now() + 100000);
      expect(
        subscription.modelForUser({ subscription: { tier: "pro", expiresAt: future } })
      ).toBe("gpt-realtime");
    });
    it("uses mini otherwise", () => {
      expect(subscription.modelForUser({})).toBe("gpt-realtime-mini");
    });
  });

  describe("grantEntitlement", () => {
    it("grants a subscription exactly once (idempotent on grantedAt)", async () => {
      User.updateOne.mockResolvedValue({ modifiedCount: 1 });
      Payment.updateOne.mockResolvedValueOnce({ modifiedCount: 1 }); // claim succeeds
      const payment = { _id: "p1", userId: "u1", planId: "weekly_pro", purpose: "subscription" };

      const first = await subscription.grantEntitlement(payment);
      expect(first).toBe(true);
      expect(User.updateOne).toHaveBeenCalledTimes(1);
      const setArg = User.updateOne.mock.calls[0][1].$set;
      expect(setArg.tier).toBe("plus");
      expect(setArg["liveInterview.secondsRemaining"]).toBe(15 * 60);

      // Redelivered webhook: the claim now fails → no second grant.
      Payment.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
      const second = await subscription.grantEntitlement(payment);
      expect(second).toBe(false);
      expect(User.updateOne).toHaveBeenCalledTimes(1);
    });

    it("adds minutes for a top-up without touching the tier", async () => {
      User.updateOne.mockResolvedValue({ modifiedCount: 1 });
      Payment.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
      const payment = { _id: "p2", userId: "u1", planId: "topup_5", purpose: "topup" };

      await subscription.grantEntitlement(payment);
      const arg = User.updateOne.mock.calls[0][1];
      expect(arg.$inc["liveInterview.secondsRemaining"]).toBe(5 * 60);
      expect(arg.$set).toBeUndefined();
    });

    it("adds a download pass for a download purchase", async () => {
      User.updateOne.mockResolvedValue({ modifiedCount: 1 });
      Payment.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
      const payment = { _id: "p3", userId: "u1", planId: "download_single", purpose: "download" };

      await subscription.grantEntitlement(payment);
      const arg = User.updateOne.mock.calls[0][1];
      expect(arg.$inc["downloads.passRemaining"]).toBe(1);
    });
  });

  describe("download entitlement", () => {
    it("paid tier downloads unlimited (consumes nothing)", async () => {
      const future = new Date(Date.now() + 100000);
      const user = { _id: "u1", subscription: { tier: "plus", expiresAt: future } };
      const r = await subscription.consumeDownload(user);
      expect(r).toEqual({ ok: true, method: "subscription" });
      expect(User.updateOne).not.toHaveBeenCalled();
    });

    it("consumes a purchased pass when available", async () => {
      User.updateOne.mockResolvedValueOnce({ modifiedCount: 1 }); // pass decrement succeeds
      const user = { _id: "u1", downloads: { passRemaining: 2 } };
      const r = await subscription.consumeDownload(user);
      expect(r).toEqual({ ok: true, method: "pass" });
    });

    it("offers NO free download — a free user with no pass is blocked", async () => {
      User.updateOne.mockResolvedValueOnce({ modifiedCount: 0 }); // no pass
      const user = { _id: "u1", downloads: { passRemaining: 0, freeDownloadUsed: false } };
      const r = await subscription.consumeDownload(user);
      expect(r.ok).toBe(false);
      // The free-download fallback is gone: only the pass decrement is attempted.
      expect(User.updateOne).toHaveBeenCalledTimes(1);
    });

    it("blocks when nothing is available", async () => {
      User.updateOne.mockResolvedValueOnce({ modifiedCount: 0 }); // no pass
      const user = { _id: "u1", downloads: { passRemaining: 0 } };
      const r = await subscription.consumeDownload(user);
      expect(r.ok).toBe(false);
    });
  });

  describe("chargeOrSkip", () => {
    it("charges an active paid tier from its per-period allowance first (not the wallet)", async () => {
      User.updateOne.mockResolvedValue({ modifiedCount: 1 });
      const future = new Date(Date.now() + 100000);
      const user = {
        _id: "u1",
        credits: 5,
        subscription: { tier: "plus", expiresAt: future, creditsRemaining: 100 },
      };
      const r = await subscription.chargeOrSkip(user, 10, { description: "grade" });
      expect(r.charged).toBe(true);
      expect(r.skipped).toBe(false);
      // Drawn entirely from the tier allowance; the persistent wallet is untouched.
      expect(user.subscription.creditsRemaining).toBe(90);
      expect(user.credits).toBe(5);
      expect(Transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -10, type: "usage" })
      );
    });

    it("falls through to the wallet once the tier allowance is exhausted", async () => {
      User.updateOne.mockResolvedValue({ modifiedCount: 1 });
      const future = new Date(Date.now() + 100000);
      const user = {
        _id: "u1",
        credits: 20,
        subscription: { tier: "plus", expiresAt: future, creditsRemaining: 4 },
      };
      const r = await subscription.chargeOrSkip(user, 10, { description: "grade" });
      expect(r.charged).toBe(true);
      // 4 from the tier bucket, the remaining 6 from the wallet.
      expect(user.subscription.creditsRemaining).toBe(0);
      expect(user.credits).toBe(14);
    });

    it("charges a free user atomically", async () => {
      User.updateOne.mockResolvedValue({ modifiedCount: 1 });
      const user = { _id: "u1", credits: 5 };
      const r = await subscription.chargeOrSkip(user, 2, { description: "grade" });
      expect(r.charged).toBe(true);
      expect(user.credits).toBe(3);
      expect(Transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -2, type: "usage" })
      );
    });

    it("reports insufficient when the balance guard fails", async () => {
      User.updateOne.mockResolvedValue({ modifiedCount: 0 });
      const user = { _id: "u1", credits: 1 };
      const r = await subscription.chargeOrSkip(user, 2, { description: "grade" });
      expect(r.insufficient).toBe(true);
      expect(r.charged).toBe(false);
    });
  });
});
