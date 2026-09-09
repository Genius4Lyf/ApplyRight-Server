// WHAT IS ALLOWED TO BE STORED AS A CV'S DESIGN.
//
// This sanitiser is not belt-and-braces over the schema — it is the ONLY check that runs.
// The draft update path uses `findByIdAndUpdate`, which does not run Mongoose validators,
// so the enums declared on the model are documentation. If this function lets something
// through, it is stored.
const { sanitizeDesign, DESIGN_KEYS } = require("../src/config/cvDesign");

describe("sanitizeDesign", () => {
  it("keeps a complete, valid design whole", () => {
    const design = {
      margins: "narrow",
      density: "relaxed",
      paper: "letter",
      font: "Georgia, serif",
      ground: "#fcfbf7",
    };
    expect(sanitizeDesign(design)).toEqual(design);
  });

  it("drops a key no control produces", () => {
    // `accent` is the live case: the control was removed because it was a no-op on
    // thirteen of the nineteen templates, and every browser that ever used it still has
    // the key sitting in localStorage waiting to be sent up.
    expect(sanitizeDesign({ margins: "wide", accent: "#4f46e5" })).toEqual({
      margins: "wide",
    });
  });

  it("drops a value outside the enum rather than failing the save", () => {
    // Failing would strand whatever else was riding along in the same request — a
    // template change, say. A CV must not be un-saveable because of a typeface.
    expect(sanitizeDesign({ margins: "enormous", paper: "a4" })).toEqual({ paper: "a4" });
  });

  it("returns undefined when nothing usable is left", () => {
    // undefined, not {}. The model stores this field as `default: undefined`, and ABSENT
    // is meaningful: it means "never chosen", which is what lets the client's local copy
    // still win on a CV that predates the field. An empty object would be a choice.
    expect(sanitizeDesign({ accent: "#000" })).toBeUndefined();
    expect(sanitizeDesign({})).toBeUndefined();
  });

  it("refuses anything that is not a design object", () => {
    [null, undefined, "narrow", 42, ["narrow"], true].forEach((bad) => {
      expect(sanitizeDesign(bad)).toBeUndefined();
    });
  });

  it("bounds the free-text fields", () => {
    // A font stack is short. Unbounded, this is somewhere to park arbitrary data on a
    // document the owner will hand to an employer.
    expect(sanitizeDesign({ font: "x".repeat(500) })).toBeUndefined();
    expect(sanitizeDesign({ ground: "y".repeat(200) })).toBeUndefined();
    expect(sanitizeDesign({ font: "Inter, sans-serif" })).toEqual({
      font: "Inter, sans-serif",
    });
  });

  it("ignores a prototype-polluting key like any other unknown", () => {
    const dirty = JSON.parse('{"margins":"wide","__proto__":{"polluted":true}}');
    const out = sanitizeDesign(dirty);
    expect(out).toEqual({ margins: "wide" });
    expect({}.polluted).toBeUndefined();
  });

  it("declares the same key set the client filters on", () => {
    // The client has a twin of this in src/lib/cvDesign.js. A key allowed by one and
    // dropped by the other is a setting that appears to save and does not.
    expect([...DESIGN_KEYS].sort()).toEqual(
      ["density", "font", "ground", "margins", "paper"].sort()
    );
  });
});
