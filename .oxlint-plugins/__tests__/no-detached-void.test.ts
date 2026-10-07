import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects detached promises and async IIFEs", async () => {
  expect(
    await lintSingleRule(
      "no-detached-void",
      "void save();\nvoid (async () => { await save(); })();",
    ),
  ).toEqual([1, 2]);
});

test("rejects void in an event callback", async () => {
  expect(
    await lintSingleRule(
      "no-detached-void",
      "const button = <button onClick={() => void save()} />;",
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1]);
});

test("rejects synchronous value-level void", async () => {
  expect(
    await lintSingleRule("no-detached-void", "void element.offsetHeight;"),
  ).toEqual([1]);
});

test("accepts captured background failures and awaited work", async () => {
  expect(
    await lintSingleRule(
      "no-detached-void",
      'detached(save(), "save");\nasync function submit() { await save(); }',
    ),
  ).toEqual([]);
});

test("accepts void type annotations and deliberate no-op callbacks", async () => {
  expect(
    await lintSingleRule(
      "no-detached-void",
      "function notify(): void {}\nconst callback: () => void = () => undefined;\nconst pending: Promise<void> = notifyAsync();",
    ),
  ).toEqual([]);
});
