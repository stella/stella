import { describe, expect, test } from "bun:test";

import { createPathMatcher } from "./path-policy";

describe("mixed-rendering path policy", () => {
  const matches = createPathMatcher([
    { type: "exact", path: "/" },
    { type: "subtree", path: "/catalogue" },
  ]);

  test.each([
    ["/", true],
    ["/catalogue", true],
    ["/catalogue/", true],
    ["/catalogue/item", true],
    ["/catalogue-private", false],
    ["/account", false],
  ] as const)("classifies %s", (pathname, expected) => {
    expect(matches(pathname)).toBe(expected);
  });

  test("treats the root subtree rule as the complete path tree", () => {
    const matchesRoot = createPathMatcher([{ type: "subtree", path: "/" }]);

    expect(matchesRoot("/account")).toBe(true);
  });

  test("normalizes a trailing slash in subtree rules", () => {
    const matchesDocs = createPathMatcher([
      { type: "subtree", path: "/docs/" },
    ]);

    expect(matchesDocs("/docs/start")).toBe(true);
    expect(matchesDocs("/docs-private")).toBe(false);
  });
});
