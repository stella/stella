import { describe, expect, test } from "bun:test";

import {
  shouldRefreshAfterNavigation,
  shouldRefreshWhenHidden,
} from "./api-version-mismatch-refresh.logic";

describe("version refresh after navigation", () => {
  test("defers the reload while the user stays on the working route", () => {
    expect(
      shouldRefreshAfterNavigation({
        currentPathname: "/workspaces/active-matter",
        detectedPathname: "/workspaces/active-matter",
        hasUnsavedWork: false,
      }),
    ).toBe(false);
  });

  test("refreshes after the router accepts navigation to another route", () => {
    expect(
      shouldRefreshAfterNavigation({
        currentPathname: "/workspaces",
        detectedPathname: "/workspaces/active-matter",
        hasUnsavedWork: false,
      }),
    ).toBe(true);
  });

  test("defers the reload while work that outlives the route is unsaved", () => {
    expect(
      shouldRefreshAfterNavigation({
        currentPathname: "/workspaces",
        detectedPathname: "/workspaces/active-matter",
        hasUnsavedWork: true,
      }),
    ).toBe(false);
  });
});

describe("version refresh when the tab is hidden", () => {
  test("refreshes a hidden tab with nothing unsaved", () => {
    expect(
      shouldRefreshWhenHidden({
        visibilityState: "hidden",
        hasUnsavedWork: false,
      }),
    ).toBe(true);
  });

  test("keeps a hidden tab with unsaved work", () => {
    expect(
      shouldRefreshWhenHidden({
        visibilityState: "hidden",
        hasUnsavedWork: true,
      }),
    ).toBe(false);
  });

  test("never refreshes a visible tab", () => {
    expect(
      shouldRefreshWhenHidden({
        visibilityState: "visible",
        hasUnsavedWork: false,
      }),
    ).toBe(false);
  });
});
