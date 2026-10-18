import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { isDbTest } from "./test-batch-plan";

test("DB imports match case-sensitive marker substrings", () => {
  expect(isDbTest("scripts/search.test.ts", 'import "pgliteish";')).toBe(true);
  expect(isDbTest("scripts/search.test.ts", 'import "PGLITE";')).toBe(false);
});

test("DB markers ignore type-only imports, comments, strings, and import types", () => {
  expect(
    isDbTest(
      "scripts/search.test.ts",
      `
        import type { PGlite } from "pglite";
        import { type Database } from "pglite";
        // import "@/api/db/root";
        const example = 'import "tests/pglite-schema"';
        type Connection = typeof import("pglite");
      `,
    ),
  ).toBe(false);
});

test("database filename suffixes classify empty-source integration and DB tests", () => {
  expect(isDbTest("scripts/empty.db.test.ts", "")).toBe(true);
  expect(isDbTest("scripts/empty.integration.test.tsx", "")).toBe(true);
  expect(isDbTest("scripts/empty.test.ts", "")).toBe(false);
});

test("PGlite marker substring behavior holds for arbitrary safe surroundings", () => {
  const safeSurroundingCharacters = fc.constantFrom(
    ...Array.from("abcdfhjkmnoqrsuvwxyz0123456789/_-"),
  );
  const safeSurroundingText = fc
    .array(safeSurroundingCharacters, { maxLength: 12 })
    .map((characters) => characters.join(""));

  assertProperty(
    "PGlite marker substring behavior holds for arbitrary safe surroundings",
    fc.property(
      fc.boolean(),
      safeSurroundingText,
      safeSurroundingText,
      (containsMarker, prefix, suffix) => {
        const marker = containsMarker ? "pglite" : "PGLITE";
        const specifier = `${prefix}${marker}${suffix}`;
        expect(
          isDbTest(
            "scripts/search.test.ts",
            `import ${JSON.stringify(specifier)};`,
          ),
        ).toBe(specifier.includes("pglite"));
      },
    ),
  );
});
