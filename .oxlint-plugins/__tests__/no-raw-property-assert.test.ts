import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects runner bindings through imports, aliases and static member reads", async () => {
  expect(
    await lintSingleRule(
      "no-raw-property-assert",
      [
        'import fc from "fast-check";',
        'import * as checks from "fast-check";',
        'import { assert as run } from "fast-check";',
        "fc.assert(property);",
        'checks["assert"](property);',
        "const alias = fc; alias[`assert`](property);",
        "const { assert: retained } = alias;",
        "const bound = fc.assert.bind(fc);",
        'const { assert: loaded } = await import("fast-check");',
        'const required = require("fast-check").assert;',
        'export { assert as runner } from "fast-check";',
        'export * from "fast-check";',
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("allows generators, the shared runner and unrelated or shadowed assertions", async () => {
  expect(
    await lintSingleRule(
      "no-raw-property-assert",
      [
        'import fc from "fast-check";',
        'import { assertProperty } from "@stll/property-testing";',
        'import { assert } from "node:console";',
        'assertProperty("values survive", fc.property(fc.string(), () => true));',
        "const local = { assert: () => true }; local.assert();",
        "const run = (fc: { assert: () => void }) => fc.assert();",
        "const unpack = (fc: { assert: () => void }) => { const { assert } = fc; assert(); };",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("keeps raw execution inside the canonical runner only", async () => {
  const source = 'import fc from "fast-check"; fc.assert(property);';
  const [owner, sibling] = await Promise.all([
    lintSingleRule("no-raw-property-assert", source, {
      sourcePath: "packages/property-testing/src/index.ts",
    }),
    lintSingleRule("no-raw-property-assert", source, {
      sourcePath: "packages/property-testing/src/other.test.ts",
    }),
  ]);
  expect(owner).toEqual([]);
  expect(sibling).toEqual([1]);
});
