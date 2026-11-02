import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects promise chains started as bare statements", async () => {
  expect(
    await lintSingleRule(
      "no-floating-promise-chain",
      [
        "flushSearchRepairs(ids).catch(report);",
        "work().then(onDone);",
        "started.finally(release);",
        "client?.close().catch(report);",
        "(work().catch(report));",
        'work()["catch"](report);',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("allows awaited, returned, bound and helper-started work", async () => {
  expect(
    await lintSingleRule(
      "no-floating-promise-chain",
      [
        "async function a() { await work().catch(report); }",
        "function b() { return work().then(onDone); }",
        "const pending = work().finally(release);",
        'detached(() => flushSearchRepairs(ids).catch(report), "contacts.flush-search-repairs");',
        "list.find(match);",
        "catchAll(report);",
      ].join("\n"),
    ),
  ).toEqual([]);
});
