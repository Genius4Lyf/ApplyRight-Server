// The REAL Aria Live prompt builder, not a mock of it.
//
// tests/ariaLive.test.js mocks the whole service, which is right for the money path and
// wrong for everything else: `projectFunnel` was imported into the builder without ever
// being exported from ai.service, so every PROJECT call threw at mint — refunded, but
// unstartable — while experience calls worked, and the suite stayed green throughout.
// Nothing here is mocked.
const { buildAriaLiveInstructions } = require("../src/services/ariaLive.service");
const { FINISH_TOOL, buildSessionConfig } = require("../src/services/realtime.service");

const build = (opts) => buildAriaLiveInstructions(opts);

describe("Aria Live prompt — both branches actually build", () => {
  it("builds for a role", () => {
    expect(() => build({ section: "experience", entryTitle: "Sales Assistant" })).not.toThrow();
  });

  it.each(["course", "personal", "work", ""])("builds for a %s project", (entryType) => {
    // The branch that was broken.
    expect(() => build({ section: "project", entryTitle: "Campus App", entryType })).not.toThrow();
  });
});

describe("Aria Live prompt — she knows when she is done, and asks before ending", () => {
  const prompt = build({ section: "experience", entryTitle: "Sales Assistant" });

  it("tells her what 'enough' looks like", () => {
    expect(prompt).toMatch(/WHEN YOU HAVE ENOUGH/);
  });

  it("recaps, asks for anything else, and only then ends", () => {
    const recap = prompt.indexOf("Recap");
    const askMore = prompt.indexOf("anything else they want to add");
    const finish = prompt.indexOf("call the finish_interview tool");
    expect(recap).toBeGreaterThan(-1);
    expect(askMore).toBeGreaterThan(recap);
    expect(finish).toBeGreaterThan(askMore);
  });

  it("never lets her end the call on her own judgement", () => {
    expect(prompt).toMatch(/Never call finish_interview without their clear agreement/);
  });

  it("knows what to do when the clock is about to run out", () => {
    // lib/ariaLive.js sends a time check; this is the half that makes it mean something.
    expect(prompt).toMatch(/TIME IS NEARLY UP/);
    expect(prompt).toMatch(/carry on in the chat/);
  });
});

describe("Aria Live prompt — she digs for what people leave out", () => {
  it("asks a role about the work nobody lists as an achievement", () => {
    const prompt = build({ section: "experience", entryTitle: "Sales Assistant" });
    expect(prompt).toMatch(/DIG FOR WHAT THEY WON'T THINK TO SAY/);
    expect(prompt).toMatch(/TRUSTED with/);
    expect(prompt).toMatch(/trained/);
  });

  it("asks a project different questions from a job", () => {
    const prompt = build({ section: "project", entryTitle: "Campus App", entryType: "personal" });
    expect(prompt).toMatch(/went wrong/);
    // A project is not asked about opening up the shop.
    expect(prompt).not.toMatch(/opening or\s+closing up/);
  });

  it("works through activities one at a time, like the typed interviewer", () => {
    const prompt = build({ section: "experience", entryTitle: "Sales Assistant" });
    expect(prompt).toMatch(/ONE ACTIVITY AT A TIME/);
  });
});

describe("Aria Live prompt — honesty rules survive the move to voice", () => {
  it("never pushes an entry-level candidate for a business metric", () => {
    const prompt = build({ section: "experience", entryTitle: "Intern", careerStage: "grad" });
    expect(prompt).toMatch(/Do NOT ask for a number/);
  });

  it("raises job requirements as leads, never as facts", () => {
    const prompt = build({
      section: "experience",
      entryTitle: "Cashier",
      brief: { mustHaves: [{ name: "cash handling" }] },
    });
    expect(prompt).toMatch(/cash handling/);
    expect(prompt).toMatch(/INVESTIGATION LEADS, never facts/);
  });

  it("never answers its own question in the user's voice", () => {
    const prompt = build({ section: "experience", entryTitle: "Clerk" });
    expect(prompt).toMatch(/never answer your own question for them/);
  });
});

describe("finish_interview — the tool that lets the call end itself", () => {
  it("is only attached when asked for", () => {
    const withTool = buildSessionConfig("x", "m", "marin", { enableFinishTool: true });
    const without = buildSessionConfig("x", "m", "marin", {});
    expect(withTool.session.tools.map((t) => t.name)).toContain("finish_interview");
    expect(without.session.tools).toBeUndefined();
  });

  it("describes consent as a precondition, not a suggestion", () => {
    expect(FINISH_TOOL.description).toMatch(/ONLY after BOTH/);
    expect(FINISH_TOOL.description).toMatch(/clearly agreed/);
  });
});

describe("Aria Live prompt — the call remembers the conversation so far", () => {
  // A call used to start from nothing every time, so a SECOND call — after the first dropped,
  // after the minutes ran out, or after the person had already typed half the interview —
  // opened with "tell me what you actually did" and made them say all of it again. On a feature
  // billed by the minute, that charges someone to repeat themselves.
  const priorTurns = [
    { who: "aria", text: "Tell me what you did day to day." },
    { who: "user", text: "I kept the acquisition unit running through the whole operation." },
    { who: "aria", text: "Did you ever spot something wrong before anyone else?" },
  ];
  const resumed = build({ section: "experience", entryTitle: "Wireline Operator", priorTurns });
  const fresh = build({ section: "experience", entryTitle: "Wireline Operator" });

  it("carries what they actually said into the call", () => {
    expect(resumed).toContain("kept the acquisition unit running");
    expect(resumed).toMatch(/ALREADY BEEN TOLD/);
  });

  it("marks who said what, so she cannot claim their words as her own question", () => {
    expect(resumed).toMatch(/THEM: I kept the acquisition unit running/);
    expect(resumed).toMatch(/YOU: Tell me what you did day to day/);
  });

  it("forbids asking for any of it again", () => {
    expect(resumed).toMatch(/NEVER ask them to repeat/i);
    expect(resumed).toMatch(/still MISSING/);
  });

  it("opens by picking up, not by introducing herself again", () => {
    expect(resumed).toMatch(/PICKING UP, NOT STARTING/);
    expect(resumed).not.toMatch(/Nothing else in the first turn/);
  });

  it("leaves a FIRST call exactly as it was", () => {
    expect(fresh).toMatch(/HOW TO OPEN\n/);
    expect(fresh).not.toMatch(/ALREADY BEEN TOLD/);
    expect(fresh).toMatch(/Nothing else in the first turn/);
  });

  it("keeps every safety rule that governs a call", () => {
    for (const rule of [/WHEN YOU HAVE ENOUGH/, /call the finish_interview tool/, /HOW TO SPEAK/]) {
      expect(resumed).toMatch(rule);
    }
  });

  it("bounds a long history rather than letting it crowd out the instructions", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      who: i % 2 ? "user" : "aria",
      text: `turn number ${i} ` + "x".repeat(900),
    }));
    const big = build({ section: "experience", priorTurns: many });
    // Only the tail is carried, and each turn is trimmed.
    expect(big).not.toContain("turn number 0 ");
    expect(big).toContain("turn number 59 ");
    expect(big).not.toContain("x".repeat(400));
    // The rules still survive at the end of it.
    expect(big).toMatch(/call the finish_interview tool/);
  });

  it("treats an empty or junk history as no history at all", () => {
    for (const turns of [
      [],
      null,
      [
        { who: "aria", text: "   " },
        { who: "nonsense", text: "hi" },
      ],
    ]) {
      const p = build({ section: "experience", priorTurns: turns });
      expect(p).not.toMatch(/ALREADY BEEN TOLD/);
      expect(p).toMatch(/Nothing else in the first turn/);
    }
  });
});

describe("Aria Live prompt — she interviews, she does not feed them answers", () => {
  // From a real call. She opened with "What's the first thing you did — something like setting
  // up equipment, checking a job, or preparing a site?" and, when the reply came back garbled,
  // answered "let's clean that up for a CV … what were you doing around site visit management
  // — like checking permits, confirming access, planning the job, or coordinating the crew?"
  //
  // Two separate failures, and both put words in the candidate's mouth: she supplied the menu,
  // and she turned a sentence she had not understood into an activity she then interviewed
  // about. People agree with a plausible list; the bullet is theirs to defend afterwards.
  const prompt = build({ section: "experience", entryTitle: "Wireline Field Operator" });

  it("forbids putting the answer inside the question", () => {
    expect(prompt).toMatch(/ASK, NEVER OFFER/);
    expect(prompt).toMatch(/must not contain its own answer/);
    // The example is a SHAPE, never a subject. An illustration written in one trade's words
    // teaches every other user's interview that register — which this codebase has shipped
    // before; see the register guard below.
    expect(prompt).toMatch(/was it\s+this, this, or this/);
  });

  it("tells her to say when she did not understand, instead of guessing", () => {
    expect(prompt).toMatch(/IF YOU DID NOT UNDERSTAND THEM/);
    expect(prompt).toMatch(/NEVER build on a phrase you did not understand/);
    expect(prompt).toMatch(/never tidy/i);
  });

  it("names the exact failure — correcting their words while guessing their meaning", () => {
    expect(prompt).toMatch(/Correcting their words while guessing their meaning/);
    expect(prompt).toMatch(/puts work they never did/);
  });

  it("stops her volunteering help nobody asked for", () => {
    expect(prompt).toMatch(/Do not volunteer advice/);
    expect(prompt).toMatch(/ask what they want help with/);
  });

  it("holds the stuck-clause back until they are actually stuck", () => {
    // This clause was the licence she used to justify the opening menu.
    expect(prompt).toMatch(/never in\s+your opening question/);
    expect(prompt).toMatch(/ONE angle, never a menu/);
  });

  it("keeps all of it in every style and depth", () => {
    for (const depth of ["thorough", "quick"]) {
      for (const style of ["friendly", "direct", "coach"]) {
        const p = build({ section: "experience", entryTitle: "Sales Assistant", depth, style });
        expect(p).toMatch(/ASK, NEVER OFFER/);
        expect(p).toMatch(/IF YOU DID NOT UNDERSTAND THEM/);
      }
    }
  });
});

describe("Aria Live prompt — she is given the trade when there is no job description", () => {
  // The user declined a JD, so the brief was empty and she had a job title and nothing else.
  // Generic questions in generic language are what a model does when it has no vocabulary.
  const noJd = {
    roleFamily: "wireline field operator",
    keywords: [{ name: "well logging" }, { name: "pressure control" }, "rig-up"],
  };
  const prompt = build({ section: "experience", entryTitle: "Wireline Field Operator", noJd });

  it("gives her the words of the trade", () => {
    expect(prompt).toMatch(/THE LANGUAGE OF THIS TRADE/);
    expect(prompt).toContain("well logging");
    expect(prompt).toContain("pressure control");
    expect(prompt).toContain("rig-up");
  });

  it("marks them as the trade's words, never this person's or an employer's", () => {
    expect(prompt).toMatch(/NOT a list of things\s+this person did/);
    expect(prompt).toMatch(/NOT an employer's requirements/);
  });

  it("forbids reading them out or asking straight off one", () => {
    expect(prompt).toMatch(/Never read any of it aloud/);
    expect(prompt).toMatch(/Never ask "did you do X\?" straight off a term here/);
    expect(prompt).toMatch(/believe them, not the list/);
  });

  it("stands down when a real job description exists — that is better evidence", () => {
    const withBrief = build({
      section: "experience",
      entryTitle: "Wireline Field Operator",
      noJd,
      brief: { mustHaves: [{ name: "pressure control" }] },
    });
    expect(withBrief).not.toMatch(/THE LANGUAGE OF THIS TRADE/);
    expect(withBrief).toMatch(/WHAT THIS JOB ASKS FOR/);
  });

  it("survives the common case of having nothing cached", () => {
    // noJd is null on most first calls — a default parameter does not catch that.
    expect(() => build({ section: "experience", noJd: null })).not.toThrow();
    expect(build({ section: "experience", noJd: null })).not.toMatch(/THE LANGUAGE OF THIS TRADE/);
    expect(build({ section: "experience", noJd: { keywords: [] } })).not.toMatch(
      /THE LANGUAGE OF THIS TRADE/
    );
  });
});

describe("Aria Live prompt — an internship is not a job", () => {
  const forType = (entryType) =>
    build({ section: "experience", entryTitle: "Assistant", entryType });

  it("coaches each kind of experience on its own terms", () => {
    expect(forType("internship")).toMatch(/This was an INTERNSHIP/);
    expect(forType("partTime")).toMatch(/PART-TIME or informal work/);
    expect(forType("volunteer")).toMatch(/VOLUNTEERING/);
    expect(forType("coursework")).toMatch(/COURSEWORK or training/);
  });

  it("never asks coursework about employers or business results", () => {
    expect(forType("coursework")).toMatch(/Do not ask about employers, customers or business/);
  });

  it("names an ordinary job too, rather than leaving her to infer it from silence", () => {
    expect(forType("job")).toMatch(/This was a JOB/);
    // …and only its own framing.
    expect(forType("job")).not.toMatch(/This was an INTERNSHIP/);
    expect(forType("job")).not.toMatch(/PART-TIME or informal/);
  });

  it("says nothing at all when the kind was never picked", () => {
    const unstated = build({ section: "experience", entryTitle: "Assistant" });
    expect(unstated).not.toMatch(/This was a JOB/);
    expect(unstated).not.toMatch(/This was an INTERNSHIP/);
  });

  it("never frames a project this way", () => {
    // A project's shape comes from projectFunnel, which owns that branch.
    const project = build({
      section: "project",
      entryTitle: "Campus App",
      entryType: "coursework",
    });
    expect(project).not.toMatch(/COURSEWORK or training\./);
  });
});

describe("Aria Live prompt — no industry is baked into it", () => {
  // The typed interviewer shipped this bug once: one trade's vocabulary written into the
  // prompt as an illustration, and every user's interview then conducted in that register.
  // tests/coachPromptRegister.test.js guards that side. This guards this one — the rules here
  // are full of examples, and an example is exactly where a register creeps in.
  // ONE trade's words. Not a ban on trade vocabulary as such: "SPEAK THEIR TRADE" deliberately
  // names three unrelated lines of work side by side (accounts, shop, field) precisely so that
  // no single one reads as the default — a balanced illustration is the technique, not the bug.
  // What must never appear is one trade's register presented as the way to ask a question,
  // which is what the first draft of "ask, never offer" did.
  const REGISTER = [
    "permit",
    "crew",
    "rigged up",
    "logging tool",
    "offshore",
    "downtime",
    "wellsite",
    "site visit",
    "pressure control",
  ];

  const neutral = build({ section: "experience", entryTitle: "Assistant" });

  it.each(REGISTER)("keeps %s out of a prompt for a role that is not that", (term) => {
    expect(neutral.toLowerCase()).not.toContain(term.toLowerCase());
  });

  it("stays clean across every stage, style and depth", () => {
    for (const careerStage of ["grad", "experienced", "changer"]) {
      for (const style of ["friendly", "direct", "coach"]) {
        for (const depth of ["thorough", "quick"]) {
          const p = build({
            section: "experience",
            entryTitle: "Assistant",
            careerStage,
            style,
            depth,
          }).toLowerCase();
          REGISTER.forEach((term) => expect(p).not.toContain(term.toLowerCase()));
        }
      }
    }
  });

  it("stays clean on a project, and for every entry type", () => {
    for (const entryType of ["job", "internship", "partTime", "volunteer", "coursework"]) {
      const p = build({ section: "experience", entryTitle: "Assistant", entryType }).toLowerCase();
      REGISTER.forEach((term) => expect(p).not.toContain(term.toLowerCase()));
    }
    for (const entryType of ["course", "personal", "work"]) {
      const p = build({ section: "project", entryTitle: "A Project", entryType }).toLowerCase();
      REGISTER.forEach((term) => expect(p).not.toContain(term.toLowerCase()));
    }
  });

  it("carries a trade's words ONLY when that trade is this user's, from their own title", () => {
    // The one legitimate source: keywords inferred from THIS user's job title. They arrive as
    // data, not as prose baked into the template, so they can never reach anyone else.
    const p = build({
      section: "experience",
      entryTitle: "Wireline Field Operator",
      noJd: { roleFamily: "wireline field operator", keywords: [{ name: "pressure control" }] },
    });
    expect(p).toContain("pressure control");
    // …and it is still absent from a prompt built for anyone else.
    expect(neutral).not.toContain("pressure control");
  });
});

describe("Aria Live prompt — she says what she thinks the employer is, and lets them correct it", () => {
  // The owner's call, and a better one than "never guess": the CONFIRMATION is the guard. An
  // unspoken assumption about the industry steers every later question and the user never finds
  // out why the questions felt wrong. Said out loud as a question, a wrong one is corrected in
  // one turn — and a right one shows the user she is working from real knowledge of their trade.
  const known = build({ section: "experience", entryTitle: "Assistant", entryCompany: "Ridgeway" });

  it("names the employer", () => {
    expect(known).toContain('The employer is "Ridgeway"');
  });

  it("puts what she believes to them as a question she may be wrong about", () => {
    expect(known).toMatch(/SETTLE WHAT KIND OF PLACE THIS WAS/);
    expect(known).toMatch(/genuinely willing to be wrong about/);
    expect(known).toContain("Ridgeway — that's <what you believe they do>, isn't it?");
  });

  it("lets her admit she has never heard of them, and ask", () => {
    expect(known).toContain("I don't know Ridgeway — what do they do?");
    expect(known).toMatch(/no embarrassment/);
    expect(known).toMatch(/small or\s+local/);
  });

  it("forbids the unspoken assumption, which is the thing that actually does damage", () => {
    expect(known).toMatch(/Never carry an unspoken assumption about the industry/);
    expect(known).toMatch(/never know why the questions felt wrong/);
  });

  it("makes her WAIT for the answer, and makes their answer final", () => {
    expect(known).toMatch(/WAIT for their answer before building on it/);
    expect(known).toMatch(/whether it confirms you or corrects you/);
    expect(known).toMatch(/never raise it again/);
  });

  it("keeps it to one turn, and off the path when the title already says the trade", () => {
    expect(known).toMatch(/One turn either way/);
    expect(known).toMatch(/when it does, get straight on with the\s+interview/);
  });

  it("still works with no employer name, without offering an empty question", () => {
    const anon = build({ section: "experience", entryTitle: "Assistant" });
    expect(anon).toMatch(/SETTLE WHAT KIND OF PLACE THIS WAS/);
    expect(anon).not.toMatch(/isn't it\?/);
    expect(anon).not.toMatch(/I don't know\s+—/);
  });

  it("names no industry of its own while doing any of it", () => {
    // The example is a placeholder, not a sector. This is the whole reason it is written
    // "<what you believe they do>" rather than with a real answer in it.
    for (const term of ["oilfield", "hospitality", "retail", "banking", "logistics"]) {
      expect(known.toLowerCase()).not.toContain(term);
    }
  });
});

describe("Aria Live prompt — she can see the rest of the CV, and may not spend it", () => {
  // The typed interviewer has had a digest of the whole document for a while. The call had
  // none, so it could spend a paid minute asking about something already written up under
  // another role, and had no way to notice when what it was being told contradicted the CV.
  const cvSummary = [
    "Summary: (not written yet)",
    "Work history:",
    "- Sales Assistant at Northgate (2021–2022): ran the till • trained two new starters",
    "Skills listed: cash handling",
  ].join("\n");
  const p = build({ section: "experience", entryTitle: "Assistant", cvSummary });

  it("shows her what the document already says", () => {
    expect(p).toMatch(/THE REST OF THEIR CV/);
    expect(p).toContain("trained two new starters");
  });

  it("is for AVOIDING a question, not asking one", () => {
    expect(p).toMatch(/Use it to AVOID a question, not to ask one/);
    expect(p).toMatch(/do not open it here as though it were new/);
  });

  it("refuses to let another role's work become this entry's evidence", () => {
    // The dangerous failure: folding a previous role's achievement into the one being built,
    // which puts a line on the CV that never happened there.
    expect(p).toMatch(/Nothing in it is evidence for THIS entry/);
    expect(p).toMatch(/Work belongs to the role it actually happened in/);
  });

  it("forbids reading it back, or pretending they said it on the call", () => {
    expect(p).toMatch(/NEVER read it aloud/);
    expect(p).toMatch(/never speak as though they told you any of it/);
  });

  it("lets her raise a contradiction once, and take their answer", () => {
    expect(p).toMatch(/plainly contradicts/);
    expect(p).toMatch(/once, warmly, and take their answer/);
  });

  it("is bounded — realtime instructions are paid for per session", () => {
    const huge = build({ section: "experience", cvSummary: "x".repeat(20000) });
    expect(huge).not.toContain("x".repeat(3000));
    // …and the rules that govern the call still survive after it.
    expect(huge).toMatch(/call the finish_interview tool/);
  });

  it("says nothing at all on a CV with nothing in it yet", () => {
    for (const empty of ["", "   ", undefined, null]) {
      expect(build({ section: "experience", cvSummary: empty })).not.toMatch(
        /THE REST OF THEIR CV/
      );
    }
  });
});
