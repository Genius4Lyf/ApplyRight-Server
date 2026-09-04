const { isTemplatePromoActive } = require("../src/config/templates");

// The launch promo that makes every premium template free.
//
// The rule is a DATE, not a switch, and these tests exist mostly to hold that shape: the
// failure that matters is a promo that never ends, because nobody writes in to complain
// about not being charged. Every "not active" case below is a case where someone's
// credits are safe.
describe("isTemplatePromoActive", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  it("is on while the end is in the future", () => {
    expect(isTemplatePromoActive({ templates: { freeUntil: future } })).toBe(true);
  });

  it("ENDS BY ITSELF once the date passes", () => {
    // There is no cron in this app. If expiry were not read here, at the moment of use,
    // it would never happen at all.
    expect(isTemplatePromoActive({ templates: { freeUntil: past } })).toBe(false);
  });

  it("is off when no date is set", () => {
    expect(isTemplatePromoActive({ templates: { freeUntil: null } })).toBe(false);
    expect(isTemplatePromoActive({ templates: {} })).toBe(false);
  });

  it("is off rather than forever when the date is unreadable", () => {
    // A garbled value must fail CLOSED. Failing open here gives the paid feature away
    // permanently and silently.
    expect(isTemplatePromoActive({ templates: { freeUntil: "not a date" } })).toBe(false);
  });

  it("survives settings with no templates block at all", () => {
    expect(isTemplatePromoActive({})).toBe(false);
    expect(isTemplatePromoActive(null)).toBe(false);
    expect(isTemplatePromoActive(undefined)).toBe(false);
  });

  it("accepts a Date as well as a string", () => {
    // Mongoose hands back a Date; /auth/config serialises it to a string. Both reach this.
    expect(isTemplatePromoActive({ templates: { freeUntil: new Date(Date.now() + 5000) } })).toBe(
      true
    );
  });
});
