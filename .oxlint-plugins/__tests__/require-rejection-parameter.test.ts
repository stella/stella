import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("requires a reason in catch and then rejection callbacks", async () => {
  expect(
    await lintSingleRule(
      "require-rejection-parameter",
      `work().catch(() => recover());
work().then(consume, () => recover());`,
      { plugin: "no-swallowed-rejection" },
    ),
  ).toEqual([1, 2]);
});

test("follows local rejection callback bindings", async () => {
  expect(
    await lintSingleRule(
      "require-rejection-parameter",
      `const recoverFailure = () => recover();
work().catch(recoverFailure);`,
      { plugin: "no-swallowed-rejection" },
    ),
  ).toEqual([2]);
});

test("allows handlers that bind the reason", async () => {
  expect(
    await lintSingleRule(
      "require-rejection-parameter",
      `work().catch(reason => recover(reason));
work().then(consume, ({message}) => recover(message));`,
      { plugin: "no-swallowed-rejection" },
    ),
  ).toEqual([]);
});

test("allows teardown but not Bun file consumption exemptions", async () => {
  expect(
    await lintSingleRule(
      "require-rejection-parameter",
      `reader.cancel().catch(() => undefined);
Bun.file(path).text().catch(() => recover());`,
      { plugin: "no-swallowed-rejection" },
    ),
  ).toEqual([2]);
});
