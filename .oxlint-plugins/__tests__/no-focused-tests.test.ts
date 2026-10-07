import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("recognizes aliased and namespace registrations", async () => {
  expect(
    await lintSingleRule(
      "no-focused-tests",
      `import {test as check} from "bun:test";
import * as suite from "bun:test";
check.only("one", () => {});
suite.describe["only"]("two", () => {});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([3, 4]);
});

test("ignores other frameworks and shadowed test bindings", async () => {
  expect(
    await lintSingleRule(
      "no-focused-tests",
      `import {test} from "bun:test";
import {it} from "other-test";
function register(test: any) {test.only("one", ()=>{});}
it.only("two",()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([]);
});

test("recognizes focused parameterized registration", async () => {
  expect(
    await lintSingleRule(
      "no-focused-tests",
      `import {test} from "bun:test";
test.only.each([1,2])("value %i", value=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([2]);
});

test("allows ordinary and conditional registrations", async () => {
  expect(
    await lintSingleRule(
      "no-focused-tests",
      `import {test} from "bun:test";
test("one",()=>{});
test.if(available)("two",()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([]);
});
