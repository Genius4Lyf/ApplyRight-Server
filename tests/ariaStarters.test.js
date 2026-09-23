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

// THE FULL SAMPLES BELONG IN ONE PLACE, AND IT IS NOT THE REPLY.
//
// Reported from use, on a Haulage Maintenance Officer role: Aria's reply ended with an
// "Examples:" heading and both sample answers spelled out, and the panel directly beneath
// it — "A FULL ANSWER SOUNDS LIKE" — then showed the same two again.
//
// The prompt caused it. It said to write the STARTERS into the reply and said nothing
// whatever about the samples, so the model generalised from one to the other. It now says
// so explicitly, and this is the net for when that is not enough — which is exactly the
// lesson of `appendStarters` above, running in the opposite direction.
//
// Why it is more than a blemish: the starters are stubs with a "___" in them and cannot be
// read as a claim. The samples are two polished, complete first-person sentences. The fold
// they normally sit behind is the whole safety mechanism — spelled into the prose they are
// first-person sentences in Aria's own voice about work the user never described.
describe("stripExampleAnswers", () => {
  const { stripExampleAnswers } = require("../src/utils/ariaStarters");

  const SAMPLES = [
    "I recorded each client meeting in our CRM and updated action items so the team could see outstanding work.",
    "I kept an inventory log of all supplies and noted expiry dates daily so the team could reorder in time.",
  ];

  const replyWith = (tail) =>
    ["Great — that kept everyone aligned.", "", "What did you handle there?", "", ...tail].join(
      "\n"
    );

  it("removes the samples the model wrote into the prose", () => {
    const out = stripExampleAnswers(
      replyWith(["Examples:", "", `- "${SAMPLES[0]}"`, `- "${SAMPLES[1]}"`]),
      SAMPLES
    );

    expect(out).not.toContain("CRM");
    expect(out).not.toContain("expiry dates");
    expect(out).toContain("What did you handle there?");
  });

  // A heading with its content removed is worse than either: it promises something and
  // then shows nothing.
  it("takes the orphaned heading with them", () => {
    const out = stripExampleAnswers(
      replyWith(["Examples:", "", `- "${SAMPLES[0]}"`, `- "${SAMPLES[1]}"`]),
      SAMPLES
    );
    // Anchored to the end this passed vacuously: with the strip disabled the heading is
    // still there, just no longer last. The heading must be GONE, wherever it sat.
    expect(out).not.toContain("Examples:");
  });

  it("leaves the starters alone — those are meant to be there", () => {
    const starters = [
      '- "I logged maintenance requests in ___"',
      '- "I updated supervisors via ___"',
    ];
    const out = stripExampleAnswers(
      replyWith(["How you could phrase it:", "", ...starters]),
      SAMPLES
    );

    expect(out).toContain("I logged maintenance requests in ___");
    expect(out).toContain("How you could phrase it:");
  });

  it("leaves an ordinary reply untouched", () => {
    const reply = replyWith(["How you could phrase it:", "", '- "I did ___"']);
    expect(stripExampleAnswers(reply, SAMPLES)).toBe(reply.trim());
  });

  // EXACT match only. Cutting on a fuzzy one risks taking Aria's real sentence with it,
  // and a duplicated sample is a blemish where a truncated reply is a broken turn.
  it("does not cut a paraphrase", () => {
    const reply = replyWith(["You might mention the log you kept of supplies."]);
    expect(stripExampleAnswers(reply, SAMPLES)).toContain("the log you kept of supplies");
  });

  it("ignores a sample too short to match safely", () => {
    const reply = replyWith(["I did it."]);
    expect(stripExampleAnswers(reply, ["I did it."])).toContain("I did it.");
  });

  it("never hands back an empty reply", () => {
    expect(stripExampleAnswers(SAMPLES[0], SAMPLES)).toBe(SAMPLES[0]);
  });

  it("copes with nothing to do", () => {
    expect(stripExampleAnswers("Just a question?", [])).toBe("Just a question?");
    expect(stripExampleAnswers("", SAMPLES)).toBe("");
  });
});
