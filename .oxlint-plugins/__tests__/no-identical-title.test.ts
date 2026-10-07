import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects duplicate static titles in one scope", async () => {
  expect(
    await lintSingleRule(
      "no-identical-title",
      `import {test as check} from "bun:test";
check("same",()=>{});
check(\`same\`,()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([3]);
});

test("keeps separate suites and registration kinds independent", async () => {
  expect(
    await lintSingleRule(
      "no-identical-title",
      `import {test,describe} from "bun:test";
describe("left",()=>{test("same",()=>{});});
describe("right",()=>{test("same",()=>{});});
test("left",()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([]);
});

test("ignores dynamic and parameterized titles", async () => {
  expect(
    await lintSingleRule(
      "no-identical-title",
      `import {test} from "bun:test";
test(title,()=>{});
test(title,()=>{});
test.each([1,2])("value %i",()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([]);
});

test("recognizes namespace registrations", async () => {
  expect(
    await lintSingleRule(
      "no-identical-title",
      `import * as suite from "bun:test";
suite.test("same",()=>{});
suite.test("same",()=>{});`,
      { plugin: "bun-test-hygiene", sourcePath: "sample.test.ts" },
    ),
  ).toEqual([3]);
});
