// THE THROTTLE THAT THROTTLED NOTHING.
//
// jobberman.service scrapes somebody else's site on borrowed goodwill, and the 5s gap
// between requests is the whole reason we are tolerated there. It was implemented as
// "read lastRequestTime, await the remainder, then write it back" — correct for exactly
// one caller, and a no-op for two: both read the same timestamp, both sleep the same
// amount, and both fire in the same millisecond. The delay produced the burst it existed
// to prevent.
//
// The service reads its spacing from JOBBERMAN_DELAY_MS so this can run in milliseconds
// rather than sitting through real five-second gaps. Set before the require, because that
// is when the constant is read.
process.env.JOBBERMAN_DELAY_MS = "60";

jest.mock("axios");

const axios = require("axios");
const jobberman = require("../src/services/jobberman.service");

// An empty page: cheerio finds no job cards, so searchJobs returns an empty result set.
// Nothing here is testing the parsing — only when requests leave.
const EMPTY_PAGE = { data: "<html><body></body></html>" };

describe("the Jobberman request queue", () => {
  let errorSpy;

  beforeEach(() => {
    // searchJobs logs the failures it swallows; that is correct behaviour, just noisy.
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    axios.get.mockReset();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("spaces concurrent callers out instead of firing them together", async () => {
    const sentAt = [];
    axios.get.mockImplementation(async () => {
      sentAt.push(Date.now());
      return EMPTY_PAGE;
    });

    // Three users searching at the same moment — the case the old code got wrong.
    await Promise.all([
      jobberman.searchJobs("developer"),
      jobberman.searchJobs("designer"),
      jobberman.searchJobs("analyst"),
    ]);

    expect(sentAt).toHaveLength(3);

    // Under the old implementation these three timestamps were within a millisecond or
    // two of each other. A little slack for timer granularity, but nothing like enough
    // to let a simultaneous burst through.
    expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(45);
    expect(sentAt[2] - sentAt[1]).toBeGreaterThanOrEqual(45);
  });

  it("refuses to let the queue grow past what a user will wait", async () => {
    axios.get.mockImplementation(async () => EMPTY_PAGE);

    // Serialising requests is only half the fix: with an unbounded queue the tenth
    // caller waits fifty seconds holding an HTTP connection open. Past four slots it is
    // kinder to fail fast and let jobSearch.service fall through to its other sources.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => jobberman.searchJobs(`query-${i}`))
    );

    expect(axios.get).toHaveBeenCalledTimes(4);

    // And the two that were turned away got the ordinary empty answer, not an exception
    // thrown at whoever was searching.
    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(Array.isArray(result.results)).toBe(true);
    }
  });

  it("does not let one failed request stall everything behind it", async () => {
    let call = 0;
    axios.get.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error("Jobberman returned 503");
      return EMPTY_PAGE;
    });

    await Promise.all([jobberman.searchJobs("a"), jobberman.searchJobs("b")]);

    // A chain built with .then(run) alone would have dropped the second request on the
    // floor when the first rejected, and every request after it for the life of the
    // process. Both must be attempted.
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});
