import { describe, expect, test } from "bun:test";

import { shouldRefreshAfterNavigation } from "./api-version-mismatch-banner.logic";

describe("version refresh boundary", () => {
  test("keeps the update user-controlled on the working route", () => {
    expect(
      shouldRefreshAfterNavigation({
        currentPathname: "/workspaces/active-matter",
        detectedPathname: "/workspaces/active-matter",
      }),
    ).toBe(false);
  });

  test("refreshes after the router accepts navigation to another route", () => {
    expect(
      shouldRefreshAfterNavigation({
        currentPathname: "/workspaces",
        detectedPathname: "/workspaces/active-matter",
      }),
    ).toBe(true);
  });
});
