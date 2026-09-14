import { describe, expect, test } from "bun:test";

import {
  DECISIONS_SEARCH_STATE,
  decisionRowsPhase,
  decisionsLoadMode,
  decisionsSearchOutage,
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
