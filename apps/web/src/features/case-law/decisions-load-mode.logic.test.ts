import { describe, expect, test } from "bun:test";

import {
  decisionRowsPhase,
  decisionsLoadMode,
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
