// The contact details a CV reuses: phone and location on the User schema.
//
// WHY THIS FILE EXISTS. `phone` was read in four places and declared in none. Mongoose
// runs strict by default, so an undeclared path is dropped on write WITHOUT an error:
// the Profile page's phone input posted a number, the request returned 200, the field
// came back empty on the next read, and every new CV therefore prefilled a blank phone.
// Nothing failed loudly at any point. Users simply retyped their number forever.
//
// A schema omission of that kind is invisible to route tests that mock the model, so it
// is pinned here against the real schema: declare the path, and assert that a write
// survives a round trip through it.
const mongoose = require("mongoose");
const User = require("../src/models/User");

describe("User schema — contact details reused across CVs", () => {
  it("declares phone and location as real paths", () => {
    // `schema.path(name)` returns undefined for an undeclared field — which is exactly
    // the state that lost every phone number, so it is the assertion that matters.
    expect(User.schema.path("phone")).toBeDefined();
    expect(User.schema.path("location")).toBeDefined();
    expect(User.schema.path("phone").instance).toBe("String");
    expect(User.schema.path("location").instance).toBe("String");
  });

  it("defaults them to empty strings rather than undefined", () => {
    // The prefill sites all read `user.phone || ""`, and the Profile form binds the value
    // straight into a controlled input — undefined there makes React switch the input to
    // uncontrolled and warn.
    const u = new User({ email: "a@b.co", password: "x" });
    expect(u.phone).toBe("");
    expect(u.location).toBe("");
  });

  it("KEEPS a written phone and location instead of silently dropping them", () => {
    const u = new User({ email: "a@b.co", password: "x" });
    u.set({ phone: "0803 123 4567", location: "Lagos, Nigeria" });

    // toObject() is what the strict-mode drop would show up in: an undeclared path never
    // reaches it, however happily `set` accepted the value.
    const plain = u.toObject();
    expect(plain.phone).toBe("0803 123 4567");
    expect(plain.location).toBe("Lagos, Nigeria");
  });

  it("carries the opt-out for Aria's offer to remember a detail", () => {
    // "Don't show again" is a persisted decision, distinct from dismissing the card once.
    const u = new User({ email: "a@b.co", password: "x" });
    expect(u.settings.hideContactSavePrompt).toBe(false);
    u.set({ "settings.hideContactSavePrompt": true });
    expect(u.toObject().settings.hideContactSavePrompt).toBe(true);
  });

  afterAll(async () => {
    // No connection is opened here (the schema is exercised in memory), but Jest is run
    // with a 10s timeout and an open mongoose handle would hold the process open.
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
});
