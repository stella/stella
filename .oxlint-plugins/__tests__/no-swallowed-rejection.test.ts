import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects empty and literal rejection fallbacks", async () => {
  expect(
    await lintSingleRule(
      "no-swallowed-rejection",
      `work().catch(() => {});
work().catch(reason => null);`,
    ),
  ).toEqual([1, 2]);
});

test("allows actual rejection handling", async () => {
  expect(
    await lintSingleRule(
      "no-swallowed-rejection",
      `work().catch(reason => {capture(reason); return fallback();});`,
    ),
  ).toEqual([]);
});

test("allows response consumption and teardown fallback", async () => {
  expect(
    await lintSingleRule(
      "no-swallowed-rejection",
      `response.json().catch(() => null);
reader.cancel().catch(() => undefined);`,
    ),
  ).toEqual([]);
});

test("keeps Bun file reads outside response exemptions", async () => {
  expect(
    await lintSingleRule(
      "no-swallowed-rejection",
      `const file=Bun.file(path);
file.text().catch(() => "");`,
    ),
  ).toEqual([2]);
});
