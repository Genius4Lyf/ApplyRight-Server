const { sanitizeAnswerLayout } = require("../src/utils/answerLayout");

// The gate between what the model CLAIMED the answer looks like and what gets drawn.
//
// A card is a stronger claim than a sentence. Prose that is slightly off reads as advice;
// a labelled row sitting inches under a button, naming a choice that button does not
// offer, reads as fact. So the rule these pin is: when a layout does not check out it is
// DROPPED — the reply falls back to prose — never half-drawn.

const ON_SCREEN = ["Student / recent grad", "Experienced", "Changing careers", "Skip for now"];

const twoGoodOptions = [
  { label: "Student / recent grad", detail: "Coursework and projects count as real evidence." },
  { label: "Experienced", detail: "I push for scope, ownership and truthful numbers." },
];

describe("sanitizeAnswerLayout — options", () => {
  it("accepts rows that all name a choice actually on screen", () => {
    const out = sanitizeAnswerLayout({
      layout: "options",
      blocks: twoGoodOptions,
      screenOptions: ON_SCREEN,
    });

    expect(out.layout).toBe("options");
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0].label).toBe("Student / recent grad");
  });

  it("drops the WHOLE card when one row names a choice that is not there", () => {
    // The failure this exists to prevent: Aria inventing a fourth button. One bad row
    // poisons the card, because a user cannot tell which of the four was the invented one.
    const out = sanitizeAnswerLayout({
      layout: "options",
      blocks: [...twoGoodOptions, { label: "Freelancer", detail: "Made up." }],
      screenOptions: ON_SCREEN,
    });

    expect(out).toBeNull();
  });

  it("refuses to draw an options card when no card is on screen at all", () => {
    expect(sanitizeAnswerLayout({ layout: "options", blocks: twoGoodOptions })).toBeNull();
    expect(
      sanitizeAnswerLayout({ layout: "options", blocks: twoGoodOptions, screenOptions: [] })
    ).toBeNull();
  });

  it("matches loosely on case and spacing, then shows the BUTTON's own wording", () => {
    // The model echoing "experienced" is not a reason to throw the card away — but the
    // card sits inches from a button reading "Experienced", so that is what it must say.
    const out = sanitizeAnswerLayout({
      layout: "options",
      blocks: [
        { label: "  student / RECENT grad ", detail: "Coursework counts." },
        { label: "experienced", detail: "Scope and numbers." },
      ],
      screenOptions: ON_SCREEN,
    });

    expect(out.blocks.map((b) => b.label)).toEqual(["Student / recent grad", "Experienced"]);
  });
});

describe("sanitizeAnswerLayout — compare", () => {
  it("accepts two or three free-form alternatives", () => {
    // Nothing to check labels against here: a comparison is about arbitrary things
    // ("a summary vs a profile"), not about buttons on screen.
    const out = sanitizeAnswerLayout({
      layout: "compare",
      blocks: [
        { label: "Professional summary", detail: "Best when you have a clear target role." },
        { label: "Personal profile", detail: "Best when your history is broad." },
      ],
    });

    expect(out.layout).toBe("compare");
    expect(out.blocks).toHaveLength(2);
  });
});

describe("sanitizeAnswerLayout — everything else falls back to prose", () => {
  it("returns null for an unknown or absent layout", () => {
    for (const layout of ["prose", "table", "grid", "", null, undefined, 42])
      expect(
        sanitizeAnswerLayout({ layout, blocks: twoGoodOptions, screenOptions: ON_SCREEN })
      ).toBeNull();
    expect(sanitizeAnswerLayout()).toBeNull();
  });

  it("needs at least two rows — one thing to say is a sentence, not a card", () => {
    expect(
      sanitizeAnswerLayout({ layout: "compare", blocks: [{ label: "A", detail: "only one" }] })
    ).toBeNull();
    expect(sanitizeAnswerLayout({ layout: "compare", blocks: [] })).toBeNull();
    expect(sanitizeAnswerLayout({ layout: "compare", blocks: "not an array" })).toBeNull();
  });

  it("drops rows missing a label or a detail, and falls back if too few survive", () => {
    // A row with a heading and no body is a broken card, not a terse one.
    const out = sanitizeAnswerLayout({
      layout: "compare",
      blocks: [{ label: "A", detail: "has both" }, { label: "B" }, { detail: "orphan" }],
    });

    expect(out).toBeNull();
  });

  it("caps the row count and the text in each", () => {
    const out = sanitizeAnswerLayout({
      layout: "compare",
      blocks: new Array(9).fill({ label: "L".repeat(200), detail: "D".repeat(400) }),
    });

    expect(out.blocks).toHaveLength(4);
    expect(out.blocks[0].label).toHaveLength(60);
    expect(out.blocks[0].detail).toHaveLength(180);
  });

  it("strips newlines, so a block cannot fake extra rows", () => {
    const out = sanitizeAnswerLayout({
      layout: "compare",
      blocks: [
        { label: "A\nB", detail: "one\n\ntwo" },
        { label: "C", detail: "three" },
      ],
    });

    expect(out.blocks[0].label).toBe("A B");
    expect(out.blocks[0].detail).toBe("one two");
  });
});
