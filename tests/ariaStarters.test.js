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

// THE SCAFFOLDS MUST BE FOR THE QUESTION ON THE TABLE.
//
// Reported from an Electrical & Electronic apprenticeship interview, both in one turn.
//
// Asked "what tools or tests did you use?", the starters were "I diagnosed faults using
// ___" / "I repaired the ___ by replacing the ___". He answered in full — multimeter,
// continuity tester, traced the fault, replaced the part, re-tested. The NEXT question was
// "who did you mainly repair appliances for?" — and the scaffolds came back as:
//
//   starters : "I diagnosed faults using ___", "I repaired appliances by replacing ___"
//   sample   : "I diagnosed faults with a multimeter and continuity tester, traced a
//               broken element or switch, replaced the faulty part, and re-tested the
//               appliance before returning it to the owner."
//
// The starters answer the question before last. The sample is HIS OWN ANSWER, tidied, and
// offered back as an example of how to answer.
//
// Both have causes in our own decisions, not the model's whim:
//   · the starters are written INTO the reply (appendStarters — they were invisible
//     otherwise), so the previous turn's are in the transcript for the model to copy;
//   · samples were moved into the user's own trade, and the nearest strong answer in
//     someone's field is the one they have just given you.
//
// Thresholds below are measured, not guessed. See the helpers for the tables.
describe("scaffold echo guards", () => {
  const { dropEchoedSamples, dropRepeatedStarters } = require("../src/utils/ariaStarters");

  const SAID =
    "I diagnosed faults using a multimeter and a continuity tester, checking for continuity " +
    "across the element, the switch and the cord to find where the circuit was broken. Once I " +
    "traced the fault, I repaired the appliance by replacing the faulty part, then tested it " +
    "again before handing it back to the owner.";

  const PREVIOUS_ARIA =
    "For the appliance repairs: what tools or tests did you use?\n\n" +
    "A few starting points:\n\n" +
    '- "I diagnosed faults using ___"\n' +
    '- "I repaired the ___ by replacing the ___"\n' +
    '- "I handled appliance repairs for ___"';

  const MESSAGES = [
    { who: "aria", text: PREVIOUS_ARIA },
    { who: "user", text: SAID },
  ];

  describe("dropEchoedSamples", () => {
    it("drops the sample that is their own answer reworded", () => {
      const kept = dropEchoedSamples(
        [
          "I diagnosed faults with a multimeter and continuity tester, traced a broken element or switch, replaced the faulty part, and re-tested the appliance before returning it to the owner.",
          "I repaired fans and generators for neighbours and small local clients, rewinding motors and replacing worn parts so devices worked reliably for daily use.",
        ],
        MESSAGES
      );

      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatch(/fans and generators/);
    });

    // The whole point of keeping samples in-trade. A guard that also removed these would
    // have handed the decision back to the unrelated-field rule it replaced.
    it.each([
      [
        "a new situation in the same trade",
        "I wired a new distribution board for a small shop and labelled every circuit so the owner could isolate a fault.",
      ],
      [
        "the same tools on a different task",
        "I used a multimeter to check standby draw on shop freezers each month and reported the ones losing efficiency.",
      ],
      [
        "work with people rather than parts",
        "I showed two younger apprentices how to test a socket safely before they touched anything live.",
      ],
    ])("keeps %s", (_label, sample) => {
      expect(dropEchoedSamples([sample], MESSAGES)).toEqual([sample]);
    });

    it("has nothing to compare against before they have said anything", () => {
      const samples = ["I did a thing that was quite specific and worth describing here."];
      expect(dropEchoedSamples(samples, [{ who: "aria", text: "Tell me?" }])).toEqual(samples);
    });

    it("copes with nothing to do", () => {
      expect(dropEchoedSamples([], MESSAGES)).toEqual([]);
      expect(dropEchoedSamples(null, null)).toEqual([]);
    });
  });

  describe("dropRepeatedStarters", () => {
    it("drops the previous turn's starters, reworded or not", () => {
      const kept = dropRepeatedStarters(
        [
          "I diagnosed faults using ___", // identical
          "I repaired appliances by replacing ___", // reworded
          "Most of my work came from ___", // genuinely for the new question
        ],
        MESSAGES
      );

      expect(kept).toEqual(["Most of my work came from ___"]);
    });

    // No starters is better than three that answer the question before last — the reply
    // still carries the question itself.
    it("is willing to drop all of them", () => {
      expect(
        dropRepeatedStarters(
          ["I diagnosed faults using ___", "I handled appliance repairs for ___"],
          MESSAGES
        )
      ).toEqual([]);
    });

    it("leaves them alone on the first turn, when there is nothing to repeat", () => {
      const fresh = ["I handled the ___ every week"];
      expect(dropRepeatedStarters(fresh, [{ who: "user", text: SAID }])).toEqual(fresh);
    });

    // Her prose is not a starter list. A starter is allowed to echo the QUESTION — that is
    // what makes it a scaffold for it.
    it("reads only her bulleted starters, not her question", () => {
      const asked = [{ who: "aria", text: "Who did you mainly repair appliances for?" }];
      const starters = ["I mainly repaired appliances for ___"];
      expect(dropRepeatedStarters(starters, asked)).toEqual(starters);
    });

    it("copes with nothing to do", () => {
      expect(dropRepeatedStarters([], MESSAGES)).toEqual([]);
      expect(dropRepeatedStarters(null, null)).toEqual([]);
    });
  });
});

// SAMPLES LEFT LOOSE IN THE PROSE.
//
// Reported from a project interview. The reply ended like this:
//
//     A few starting points:
//     - "I developed the ___ module that ___"
//     - "I ran user testing sessions and ___"
//
//     "I created a searchable mobilisation checklist module used by crews to prepare
//     jobs, reducing lookup time." "I led field validation sessions with new operators."
//
// Two finished first-person sentences run together at the end of the message — and NO
// "a full answer sounds like" panel beneath, because the field came back empty and the
// panel renders nothing when it has nothing.
//
// So `stripExampleAnswers` was helpless: it matches the prose against the FIELD, and the
// field was the thing that was missing. Unlabelled and unfolded, those two sentences are
// indistinguishable from Aria asserting the user did them — the exact failure the fold
// exists to prevent.
//
// Stripping would be the easy fix and the wrong one: the user loses the samples entirely.
// Promoting puts them where they were always meant to go.
describe("promoteInlineSamples", () => {
  const { promoteInlineSamples } = require("../src/utils/ariaStarters");

  const SAMPLE_A =
    "I created a searchable mobilisation checklist module used by crews to prepare jobs, reducing lookup time.";
  const SAMPLE_B =
    "I led field validation sessions with new operators to refine content and improve onboarding speed.";

  const REPORTED = [
    "Got it — no operating work for this entry.",
    "",
    "What was your specific part on OPSLINE? Keep it to one thing you did.",
    "",
    "A few starting points:",
    "",
    '- "I developed the ___ module that ___"',
    '- "I ran user testing sessions and ___"',
    "",
    `"${SAMPLE_A}" "${SAMPLE_B}"`,
  ].join("\n");

  it("lifts loose samples out of the reply", () => {
    const out = promoteInlineSamples(REPORTED, []);

    expect(out.reply).not.toContain("mobilisation checklist");
    expect(out.reply).not.toContain("field validation sessions");
    expect(out.reply).toContain("What was your specific part on OPSLINE?");
  });

  it("puts them in the field, so the panel has something to show", () => {
    const out = promoteInlineSamples(REPORTED, []);
    expect(out.exampleAnswers).toEqual([SAMPLE_A, SAMPLE_B]);
  });

  it("leaves the starters where they belong", () => {
    const out = promoteInlineSamples(REPORTED, []);

    expect(out.reply).toContain('- "I developed the ___ module that ___"');
    expect(out.reply).toContain("A few starting points:");
  });

  // The model's own field is its considered answer; this is a rescue, and a rescue does
  // not overrule one.
  it("does not overwrite samples the model returned properly", () => {
    const proper = ["A sample the model actually returned in the field, long enough to count."];
    const out = promoteInlineSamples(REPORTED, proper);

    expect(out.exampleAnswers).toEqual(proper);
    // The loose copy still leaves the prose — it is a duplicate either way.
    expect(out.reply).not.toContain("mobilisation checklist");
  });

  // THE SHAPES THAT MUST SURVIVE. Aria quotes things legitimately and often.
  it("leaves a quotation that sits inside a sentence", () => {
    const reply =
      'The job description asks for "Maintaining accurate records of production" — did you do that here?';
    expect(promoteInlineSamples(reply, []).reply).toBe(reply);
  });

  it("leaves a quoted starter on its own bullet", () => {
    const reply = 'Ways in:\n\n- "I logged the maintenance requests we raised each week in ___"';
    expect(promoteInlineSamples(reply, []).reply).toBe(reply);
  });

  it("leaves a short quoted phrase alone", () => {
    const reply = 'They call it "the wash bay".';
    expect(promoteInlineSamples(reply, []).reply).toBe(reply);
  });

  it("takes an orphaned heading with them", () => {
    const reply = `A question?\n\nExamples:\n\n"${SAMPLE_A}"`;
    expect(promoteInlineSamples(reply, []).reply).not.toContain("Examples:");
  });

  it("never hands back an empty reply", () => {
    const out = promoteInlineSamples(`"${SAMPLE_A}"`, []);
    expect(out.reply).toContain("mobilisation checklist");
  });

  it("copes with nothing to do", () => {
    expect(promoteInlineSamples("Just a question?", []).reply).toBe("Just a question?");
    expect(promoteInlineSamples("", []).exampleAnswers).toEqual([]);
  });
});
