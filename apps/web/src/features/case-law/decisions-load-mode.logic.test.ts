import { describe, expect, test } from "bun:test";

import {
  DECISIONS_SEARCH_STATE,
  decisionRowsPhase,
  decisionsLoadMode,
  decisionsSearchOutage,
  queryAnsweredByRows,
  rowsAnswerRequestedSearch,
} from "./decisions-load-mode.logic";

describe("whether the results route waits for its rows", () => {
  test("a cold arrival waits: there is nothing to show and nothing to list", () => {
    expect(decisionsLoadMode({ cause: "enter", hasCachedPages: false })).toBe(
      "await",
    );
  });

  test("a preload waits too, so the cache it fills is the whole page", () => {
    expect(decisionsLoadMode({ cause: "preload", hasCachedPages: false })).toBe(
      "await",
    );
  });

  test("changing a filter on a drawn page never waits", () => {
    expect(decisionsLoadMode({ cause: "stay", hasCachedPages: false })).toBe(
      "background",
    );
  });

  test("a search already in the cache never waits, however it was reached", () => {
    for (const cause of ["enter", "preload", "stay"] as const) {
      expect(decisionsLoadMode({ cause, hasCachedPages: true })).toBe(
        "background",
      );
    }
  });
});

describe("what the results region shows while the page stays put", () => {
  test("a pending render stands in skeleton, never in rows it does not have", () => {
    expect(
      decisionRowsPhase({
        isLoading: false,
        isPlaceholderData: true,
        routeState: "pending",
      }),
    ).toBe("skeleton");
  });

  test("a first fetch under a drawn page is the same skeleton", () => {
    expect(
      decisionRowsPhase({
        isLoading: true,
        isPlaceholderData: false,
        routeState: "loaded",
      }),
    ).toBe("skeleton");
  });

  test("rows kept from the previous search are stale, not loading", () => {
    expect(
      decisionRowsPhase({
        isLoading: false,
        isPlaceholderData: true,
        routeState: "loaded",
      }),
    ).toBe("stale");
  });

  test("a settled page shows its own rows", () => {
    expect(
      decisionRowsPhase({
        isLoading: false,
        isPlaceholderData: false,
        routeState: "loaded",
      }),
    ).toBe("rows");
  });
});

describe("whether the results region stands in for an unreachable search", () => {
  test("the server renders the outage its own read hit", () => {
    expect(
      decisionsSearchOutage({
        hasPages: false,
        isQueryOutage: true,
        loaded: DECISIONS_SEARCH_STATE.unavailable,
      }),
    ).toBe(true);
  });

  // The rehydrating render is the case this exists for: the query's failure
  // arrives as a bare Error, so `isQueryOutage` is false where the server had
  // it true, and only the load's own conclusion still carries the outage.
  test("hydration keeps the outage the server rendered", () => {
    expect(
      decisionsSearchOutage({
        hasPages: false,
        isQueryOutage: false,
        loaded: DECISIONS_SEARCH_STATE.unavailable,
      }),
    ).toBe(true);
  });

  test("a page the query went on to fetch replaces the outage", () => {
    expect(
      decisionsSearchOutage({
        hasPages: true,
        isQueryOutage: false,
        loaded: DECISIONS_SEARCH_STATE.unavailable,
      }),
    ).toBe(false);
  });

  test("a failure raised in this browser is an outage on its own", () => {
    expect(
      decisionsSearchOutage({
        hasPages: true,
        isQueryOutage: true,
        loaded: DECISIONS_SEARCH_STATE.answered,
      }),
    ).toBe(true);
  });

  test("a load that answered never stands in", () => {
    expect(
      decisionsSearchOutage({
        hasPages: false,
        isQueryOutage: false,
        loaded: DECISIONS_SEARCH_STATE.answered,
      }),
    ).toBe(false);
  });

  test("a render with no load behind it yet waits rather than reporting", () => {
    expect(
      decisionsSearchOutage({
        hasPages: false,
        isQueryOutage: false,
        loaded: undefined,
      }),
    ).toBe(false);
  });
});

describe("which search the rows on screen answer", () => {
  // One run of the page: a search settles, the reader asks another, and the
  // previous rows stay up while it is in flight. The term a row is read with
  // has to lag the URL for exactly that window and no longer, or a row is
  // marked with words that did not find it and opens on them too.
  test("the term stays with the rows until the new ones arrive", () => {
    const settled = queryAnsweredByRows({
      phase: "rows",
      requested: "smlouva",
      shown: undefined,
    });
    expect(settled).toBe("smlouva");

    const refreshing = queryAnsweredByRows({
      phase: "stale",
      requested: "náhrada škody",
      shown: settled,
    });
    expect(refreshing).toBe("smlouva");

    expect(
      queryAnsweredByRows({
        phase: "rows",
        requested: "náhrada škody",
        shown: refreshing,
      }),
    ).toBe("náhrada škody");
  });

  // A search with nothing to keep draws a skeleton, and a skeleton has no row
  // to disagree with: the reader is already looking at the new search.
  test("a skeleton answers the search being fetched", () => {
    expect(
      queryAnsweredByRows({
        phase: "skeleton",
        requested: "náhrada škody",
        shown: "smlouva",
      }),
    ).toBe("náhrada škody");
  });

  test("clearing the box is a search like any other", () => {
    expect(
      queryAnsweredByRows({
        phase: "stale",
        requested: undefined,
        shown: "smlouva",
      }),
    ).toBe("smlouva");
    expect(
      queryAnsweredByRows({
        phase: "rows",
        requested: undefined,
        shown: "smlouva",
      }),
    ).toBeUndefined();
  });
});

describe("whether an action beside the rows may act on the URL's search", () => {
  // The line above the rows names the search those rows answered, while the
  // action on it reads the URL. Between the two searches those are different
  // queries, so the action would widen words the reader has seen no answer to.
  test("stale rows withhold it, because the URL has moved past them", () => {
    expect(rowsAnswerRequestedSearch("stale")).toBe(false);
  });

  test("a skeleton has no rows to offer an action beside", () => {
    expect(rowsAnswerRequestedSearch("skeleton")).toBe(false);
  });

  test("settled rows and the URL are one search, so it is offered", () => {
    expect(rowsAnswerRequestedSearch("rows")).toBe(true);
  });
});
