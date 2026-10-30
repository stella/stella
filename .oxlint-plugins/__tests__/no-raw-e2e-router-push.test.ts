import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "no-raw-e2e-router-push";

test("rejects a raw history push however history is reached", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "declare const page: { evaluate: (run: (path: string) => void, path: string) => Promise<void> };",
        'void page.evaluate((path) => history.pushState(null, "", path), "/law");',
        'void page.evaluate((path) => window.history.pushState(null, "", path), "/law");',
        'void page.evaluate((path) => globalThis.history["pushState"](null, "", path), "/law");',
        'void page.evaluate((path) => self.history.pushState(null, "", path), "/law");',
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4, 5]);
});

test("accepts the wrapper check, other history calls and other objects", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "declare const router: { history: { pushState: (path: string) => void } };",
        "declare const pushRouterPath: (path: string) => Promise<void>;",
        'void history.pushState.toString().includes("[native code]");',
        'history.replaceState(null, "", "/law");',
        'router.history.pushState("/law");',
        'void pushRouterPath("/law");',
      ].join("\n"),
    ),
  ).toEqual([]);
});
