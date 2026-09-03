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
});
