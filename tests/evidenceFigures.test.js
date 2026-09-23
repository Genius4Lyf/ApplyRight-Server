const { verifiedInterviewEvidence } = require("../src/controllers/coach.controller");

// A NUMBER ON A CV HAS TO HAVE BEEN SAID BY THE PERSON WHOSE CV IT IS.
//
// verifiedInterviewEvidence checked the sourceQuote and stopped. The `tools` and `metrics`
// travelling with it went through untouched — and those two are precisely what
// generateBulletsFromDescription hands the writer, under the headings "CONFIRMED TOOLS"
// and "USER-STATED METRICS". Neither word was true of them. A real quote carrying an
// invented 18% was the shortest route a fabricated number had onto a finished CV, and it
// widened the longer an interview ran.
//
// THE RULE (chosen over the stricter same-sentence one): the figure must appear SOMEWHERE
// in what the candidate typed. Anything conjured from nothing is caught; Aria's own
// rephrasing survives, because she routinely lifts a number out of the turn it was said in
// and into a tidier claim. The third test below is the whole reason that trade was made.
const said = (text) => [{ who: "user", text }];

const run = (item, turns) => verifiedInterviewEvidence([item], turns)[0];

const QUOTE = "I greased the sheaves and shackles before every rig-up";

describe("metrics are checked against what the candidate actually said", () => {
  it("keeps a figure the candidate used", () => {
    const out = run(
      { claim: "Six-hourly checks", sourceQuote: QUOTE, metrics: ["checks every 6 hours"] },
      said(`${QUOTE}. We did checks every 6 hours.`)
    );
    expect(out.metrics).toEqual(["checks every 6 hours"]);
  });

  it("drops a figure that appears nowhere in the conversation", () => {
    const out = run(
      { claim: "Cut downtime", sourceQuote: QUOTE, metrics: ["cut downtime by 18%"] },
      said(QUOTE)
    );
    expect(out.metrics).toEqual([]);
    // The quote itself is untouched — this narrows what rides along, it does not reject
    // the claim. Losing the whole answer over one bad number would be the worse trade.
    expect(out.sourceQuote).toBe(QUOTE);
  });

  // WHY B AND NOT A. Under same-sentence matching this is thrown away: the candidate wrote
  // "eighteen percent", Aria sensibly wrote "18%", and a real achievement disappears.
  it("counts a number the candidate spelled out", () => {
    const out = run(
      { claim: "Cut downtime", sourceQuote: QUOTE, metrics: ["cut downtime by 18%"] },
      said(`${QUOTE}. We cut downtime by about eighteen percent that quarter.`)
    );
    expect(out.metrics).toEqual(["cut downtime by 18%"]);
  });

  it("handles a spelled-out compound", () => {
    const out = run(
      { claim: "Wells", sourceQuote: QUOTE, metrics: ["25 wells"] },
      said(`${QUOTE}. I worked twenty-five wells that year.`)
    );
    expect(out.metrics).toEqual(["25 wells"]);
  });

  it("reads 1,200 and 1200 as the same figure", () => {
    const out = run(
      { claim: "Hours", sourceQuote: QUOTE, metrics: ["1200 hours"] },
      said(`${QUOTE}. About 1,200 hours across the year.`)
    );
    expect(out.metrics).toEqual(["1200 hours"]);
  });

  // Prose is not a claim about size, so there is nothing in it to fabricate.
  it("keeps a metric with no figure in it at all", () => {
    const out = run(
      { claim: "Downtime", sourceQuote: QUOTE, metrics: ["reduced downtime"] },
      said(QUOTE)
    );
    expect(out.metrics).toEqual(["reduced downtime"]);
  });

  // Half-supported is not supported: one true number must not carry an invented one.
  it("requires EVERY figure in a metric, not just one of them", () => {
    const out = run(
      { claim: "Checks", sourceQuote: QUOTE, metrics: ["6-hourly checks across 30 wells"] },
      said(`${QUOTE}. We did checks every 6 hours.`)
    );
    expect(out.metrics).toEqual([]);
  });
});

describe("tools are checked the same way — a tool is a name, so it must be named", () => {
  it("keeps a tool the candidate named", () => {
    const out = run(
      { claim: "Reporting", sourceQuote: QUOTE, tools: ["WinchSafe"] },
      said(`${QUOTE}. I monitored WinchSafe during logging.`)
    );
    expect(out.tools).toEqual(["WinchSafe"]);
  });

  it("drops a tool that appears nowhere", () => {
    const out = run({ claim: "Reporting", sourceQuote: QUOTE, tools: ["Power BI"] }, said(QUOTE));
    expect(out.tools).toEqual([]);
  });

  it("matches across spacing and punctuation, so one product is one thing", () => {
    const out = run(
      { claim: "Reporting", sourceQuote: QUOTE, tools: ["Power BI"] },
      said(`${QUOTE}. I built the dashboard in PowerBI.`)
    );
    expect(out.tools).toEqual(["Power BI"]);
  });

  // Filtered BEFORE the requirement match is computed. Otherwise the model typing a tool
  // name would be enough to tick that tool on "what this job asks for" — a fabricated
  // number is bad, a fabricated CONFIRMED skill on a checklist is worse.
  it("cannot let an unsaid tool satisfy a requirement", () => {
    const requirements = [
      { id: "req_powerbi", name: "Power BI", type: "tool", aliases: [], proofSignals: [] },
    ];
    const [out] = verifiedInterviewEvidence(
      [
        {
          claim: "Reporting",
          sourceQuote: QUOTE,
          tools: ["Power BI"],
          requirementIds: ["req_powerbi"],
        },
      ],
      said(QUOTE),
      requirements
    );
    expect(out.tools).toEqual([]);
    expect(out.requirementIds).toEqual([]);
  });
});
