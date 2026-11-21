import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const GEOMETRY_SOURCE = [
  "page.waitForTimeout(100);",
  "page.setViewportSize({ width: 800, height: 600 });",
  "locator.boundingBox();",
  "stableBoundingBox(page, locator);",
].join("\n");

test("rejects unstable geometry APIs in geometry specs", async () => {
  expect(
    await lintSingleRule("require-stable-geometry", GEOMETRY_SOURCE, {
      sourcePath: "apps/web/e2e/ui-playground/example.geometry.spec.ts",
    }),
  ).toEqual([1, 2, 3]);
});

test("rejects unstable geometry APIs in hyphenated geometry specs", async () => {
  expect(
    await lintSingleRule("require-stable-geometry", GEOMETRY_SOURCE, {
      sourcePath: "apps/web/e2e/specs/example-geometry.spec.ts",
    }),
  ).toEqual([1, 2, 3]);
});

test("accepts the same APIs outside geometry specs", async () => {
  expect(
    await lintSingleRule("require-stable-geometry", GEOMETRY_SOURCE, {
      sourcePath: "apps/web/e2e/specs/example.spec.ts",
    }),
  ).toEqual([]);
});

test("the executed lint fixture exercises the same rejected APIs", async () => {
  expect(
    await lintSingleRule("require-stable-geometry", GEOMETRY_SOURCE, {
      sourcePath:
        ".oxlint-plugins/__fixtures__/require-stable-geometry.fixture.ts",
    }),
  ).toEqual([1, 2, 3]);
});
