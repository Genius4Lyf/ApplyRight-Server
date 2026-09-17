// The catalog and the Payment model have to agree about what a purchase IS.
//
// They did not. `aria_topup` was added to config/catalog.js without being added to
// Payment.purpose's enum, so Payment.create threw a ValidationError on every Aria-call
// checkout and createCheckout's catch turned it into a flat 500 "Failed to start checkout" —
// no field name, no clue, and nothing in the suite noticed. The feature was unbuyable.
//
// So this does not assert "aria_topup is allowed". It asserts the two lists AGREE, which is
// the version that catches the NEXT purpose someone adds.
const mongoose = require("mongoose");
const Payment = require("../src/models/Payment");
const { CATALOG } = require("../src/config/catalog");
const subscription = require("../src/services/subscription.service");

const purposeEnum = () => Payment.schema.path("purpose").enumValues;
const catalogPurposes = () => [...new Set(Object.values(CATALOG).map((i) => i.purpose))];

describe("catalog purposes ↔ Payment.purpose", () => {
  it("every purpose the catalog can sell is one Payment will accept", () => {
    const allowed = purposeEnum();
    const missing = catalogPurposes().filter((p) => !allowed.includes(p));
    expect(missing).toEqual([]);
  });

  it("validates a real document for every purpose in the catalog", () => {
    // The enum check above is necessary but not sufficient — this is what checkout actually
    // does, so it is what the test should actually do.
    for (const purpose of catalogPurposes()) {
      const doc = new Payment({
        userId: new mongoose.Types.ObjectId(),
        amountNgn: 1000,
        currency: "NGN",
        flwTxRef: `AR-${purpose}`,
        status: "pending",
        purpose,
        planId: "x",
      });
      const err = doc.validateSync();
      expect(err?.errors?.purpose).toBeUndefined();
    }
  });

  it("keeps Aria call minutes and interview minutes as distinct purposes", () => {
    // The whole reason there are two balances. If these ever collapse into one value, money
    // paid for build calls starts topping up interview practice and nothing errors.
    expect(CATALOG.aria_10.purpose).toBe("aria_topup");
    expect(CATALOG.topup_10.purpose).toBe("topup");
    expect(CATALOG.aria_10.purpose).not.toBe(CATALOG.topup_10.purpose);
  });
});

describe("receipt lines name the right product", () => {
  // Reached through the exported helper rather than by sending an email.
  const linesFor = (id) => subscription.receiptLinesFor(CATALOG[id]).join(" ");

  it("calls Aria call minutes what they are", () => {
    expect(linesFor("aria_10")).toMatch(/Aria call minute/i);
    expect(linesFor("aria_10")).not.toMatch(/interview/i);
  });

  it("still calls interview minutes what THEY are", () => {
    expect(linesFor("topup_10")).toMatch(/live interview minute/i);
  });
});
