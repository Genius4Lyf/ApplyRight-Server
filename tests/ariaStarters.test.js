// THE ANSWER STARTERS ALWAYS APPEAR.
//
// Reported bug: the starters ("I coordinated meetings for ___") showed up under some of
// Aria's questions and not others, with no pattern a user could see.
//
// The cause was that nothing ever required them. The prompt asked for them only as a JSON
// FIELD, the client dropped that field on the assumption Aria repeats them as bullets in
// her reply, and nothing enforced that assumption — so they were visible only on the turns
// where the model happened to volunteer them.
const { hasListItem, appendStarters } = require("../src/utils/ariaStarters");

const STARTERS = ["I coordinated meetings for ___", "I processed invoices for ___"];

describe("hasListItem — the duplication guard", () => {
  it("sees the bullets Aria writes herself", () => {
    expect(hasListItem('Some ways in:\n\n- "I did ___"\n- "I handled ___"')).toBe(true);
  });

  it("sees the other markers a model reaches for", () => {
    expect(hasListItem("* starred item")).toBe(true);
    expect(hasListItem("+ plus item")).toBe(true);
    expect(hasListItem("1. numbered item")).toBe(true);
    expect(hasListItem("2) also numbered")).toBe(true);
    expect(hasListItem("  - indented under a paragraph")).toBe(true);
  });

  it("is not fooled by a dash that is only punctuation", () => {
    // The em-dash and the mid-sentence hyphen are all over Aria's voice; treating either as
    // a list would suppress the starters on almost every turn.
    expect(hasListItem("That sounds useful — what did you do exactly?")).toBe(false);
    expect(hasListItem("A well-run process is worth describing.")).toBe(false);
    expect(hasListItem("-")).toBe(false); // a bare marker with nothing after it
  });

  it("says no to an empty reply", () => {
    expect(hasListItem("")).toBe(false);
    expect(hasListItem(null)).toBe(false);
  });
});

describe("appendStarters", () => {
  it("adds them when the reply offers none — the whole point", () => {
    const out = appendStarters("What was your role in the invoices?", STARTERS, "Ways in:");
    expect(out).toContain("What was your role in the invoices?");
    expect(out).toContain("Ways in:");
    expect(out).toContain('- "I coordinated meetings for ___"');
    expect(out).toContain('- "I processed invoices for ___"');
  });

  it("LEAVES A REPLY ALONE when Aria already bulleted something", () => {
    // Appending a second list under one she wrote herself reads as a stutter — and seeing
    // the same thing twice was the complaint that had these removed from the UI in the
    // first place.
    const already = 'Here are some ways to start:\n\n- "I coordinated meetings for ___"';
    expect(appendStarters(already, STARTERS, "Ways in:")).toBe(already);
  });

  it("keeps the blanks intact", () => {
    // "___" is the entire point of a starter: it is where the user's own detail goes.
    expect(appendStarters("Q?", ["I handled ___ every week"])).toContain("___ every week");
  });

  it("quotes them, so they read as words to say rather than as claims", () => {
    // Unquoted, "I processed invoices for ___" under Aria's question reads as her telling
    // the user what they did.
    expect(appendStarters("Q?", ["I processed invoices"])).toContain('- "I processed invoices"');
  });

  it("does not double up quotes the model already added", () => {
    expect(appendStarters("Q?", ['"I processed invoices"'])).toContain('- "I processed invoices"');
    expect(appendStarters("Q?", ['"I processed invoices"'])).not.toContain('""');
  });

  it("falls back to its own lead-in when the model sent none", () => {
    const out = appendStarters("Q?", STARTERS, "");
    expect(out).toContain("Here are some ways to start your answer:");
  });

  it("returns the reply untouched when there are no starters", () => {
    expect(appendStarters("Just a question.", [])).toBe("Just a question.");
    expect(appendStarters("Just a question.", null)).toBe("Just a question.");
  });

  it("ignores blank starters rather than emitting empty bullets", () => {
    const out = appendStarters("Q?", ["", "   ", "I did ___"]);
    expect(out).toContain('- "I did ___"');
    expect(out.split("\n").filter((l) => l.trim() === "-")).toHaveLength(0);
  });

  it("produces real markdown bullets, so the per-bullet copy control finds them", () => {
    // The copy affordance keys off <li> nodes in the rendered reply. If these were not
    // genuine list items the user could not lift one, which is half of what they are for.
    const out = appendStarters("Q?", STARTERS);
    expect(hasListItem(out)).toBe(true);
  });
});
