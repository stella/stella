import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("recognizes aliased and namespace registrations", async () => {
  expect(
    await lintSingleRule(
      "no-disabled-tests",
      `import {test as check} from "bun:test";
import * as suite from "bun:test";
check.skip("one", () => {});
suite.describe["skip"]("two", () => {});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([3, 4]);
});

test("ignores other frameworks and shadowed test bindings", async () => {
  expect(
    await lintSingleRule(
      "no-disabled-tests",
      `import {test} from "bun:test";
import {it} from "other-test";
function register(test: any) {test.skip("one", ()=>{});}
it.skip("two",()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([]);
});

test("allows a documented disabled registration", async () => {
  expect(
    await lintSingleRule(
      "no-disabled-tests",
      `import {test} from "bun:test";
// Disabled until the external service fixture is available
test.skip("integration",()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([]);
});

test("allows conditional registrations", async () => {
  expect(
    await lintSingleRule(
      "no-disabled-tests",
      `import {test} from "bun:test";
test.skipIf(!available)("integration",()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([]);
});
