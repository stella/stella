import { describe, expect, test } from "bun:test";

import { taggedComment } from "../test-timing.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const PLUGIN = "test-timing";
const lintWith = (rule: string) => async (source: string) =>
  lintSingleRule(rule, source, {
    plugin: PLUGIN,
    sourcePath: "source.test.ts",
  });

const lint = lintWith("no-real-time-wait");

describe("no-real-time-wait", () => {
  test("reports Bun, timers/promises and shared-helper sleeps", async () => {
    expect(
      await lint(
        [
          'import { setTimeout as wait } from "node:timers/promises";',
          'import * as timers from "timers/promises";',
          'import { sleep } from "@stll/concurrency/sleep";',
          'import { sleep as bunSleep } from "bun";',
          "await Bun.sleep(5);",
          "await wait(5);",
          "await timers.setTimeout(5);",
          "await sleep(5);",
          "await bunSleep(5);",
          "Bun.sleepSync(5);",
        ].join("\n"),
      ),
    ).toEqual([5, 6, 7, 8, 9, 10]);
  });

  test("reports Playwright waitForTimeout on any receiver", async () => {
    expect(
      await lint(
        "await page.waitForTimeout(500);\nawait frame.waitForTimeout(10);",
      ),
    ).toEqual([1, 2]);
  });

  test("reports promises settled from the global setTimeout", async () => {
    expect(
      await lint(
        [
          "await new Promise((resolve) => setTimeout(resolve, 5));",
          "const sleep = (ms: number) =>",
          "  new Promise<void>((resolve) => {",
          "    globalThis.setTimeout(() => resolve(), ms);",
          "  });",
        ].join("\n"),
      ),
    ).toEqual([1, 3]);
  });

  test("accepts timers that are not waits and locally shadowed names", async () => {
    expect(
      await lint(
        [
          "const handle = setTimeout(() => undefined, 5);",
          "const Bun = { sleep: async (_ms: number) => undefined };",
          "await Bun.sleep(5);",
          "const setTimeout = (fn: () => void) => fn();",
          "await new Promise<void>((resolve) => setTimeout(resolve));",
          "await new Promise<void>((resolve) => { queueMicrotask(resolve); });",
          'import { sleep } from "./local-sleep";',
          "await sleep(5);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("accepts setTimeout-built waits once the file installs fake timers", async () => {
    expect(
      await lint(
        [
          'import { jest } from "bun:test";',
          'import { sleep } from "@stll/concurrency/sleep";',
          "jest.useFakeTimers();",
          "const pending = sleep(1000);",
          "await new Promise((resolve) => setTimeout(resolve, 5));",
          "await Bun.sleep(5);",
        ].join("\n"),
      ),
    ).toEqual([6]);
  });

  test("fake timer exemptions follow canonical imported owners", async () => {
    expect(
      await lint(
        [
          "const jest = { useFakeTimers() {} };",
          "jest.useFakeTimers();",
          "await new Promise((resolve) => setTimeout(resolve, 5));",
        ].join("\n"),
      ),
    ).toEqual([3]);
    expect(
      await lint(
        [
          'import { jest as clock } from "bun:test";',
          "clock.useFakeTimers();",
          "await new Promise((resolve) => setTimeout(resolve, 5));",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("accepts a stated real-time reason on the line or directly above", async () => {
    expect(
      await lint(
        [
          "// real-time: the helper under test is the sleep itself",
          "await Bun.sleep(5);",
          "await Bun.sleep(5); // real-time: pacing is what this test measures",
          "// real-time: the stream's pacing is the behaviour under test",
          "const stream = new ReadableStream({",
          "  pull: async () => {",
          "    await Bun.sleep(2);",
          "  },",
          "});",
        ].join("\n"),
      ),
    ).toEqual([7]);
  });

  test("rejects an untagged, empty or detached reason", async () => {
    expect(
      await lint(
        [
          "// Give the worker time to finish.",
          "await Bun.sleep(5);",
          "// real-time:",
          "await Bun.sleep(5);",
          "// real-time: the sleep under test",
          "",
          "await Bun.sleep(5);",
        ].join("\n"),
      ),
    ).toEqual([2, 4, 7]);
  });
});

const lintLoops = lintWith("no-polling-loop");

describe("no-polling-loop", () => {
  test("reports loops that wait on the clock until a predicate holds", async () => {
    expect(
      await lintLoops(
        [
          'import { sleep } from "@stll/concurrency/sleep";',
          "for (let i = 0; i < 100 && !done(); i++) await sleep(5);",
          "while (true) {",
          "  if (ready()) break;",
          "  await Bun.sleep(10);",
          "}",
          "while (!seen) await new Promise((r) => setImmediate(r));",
          "do {",
          "  await Promise.resolve();",
          "} while (pending.length > 0);",
        ].join("\n"),
      ),
    ).toEqual([2, 3, 7, 8]);
  });

  test("follows waits into callbacks and helpers of the same file", async () => {
    expect(
      await lintLoops(
        [
          'import { sleep } from "@stll/concurrency/sleep";',
          'import { act } from "react";',
          "const tick = async () => {",
          "  await sleep(0);",
          "};",
          "async function settle() {",
          "  await tick();",
          "}",
          "while (!done()) await settle();",
          "for (let i = 0; i < 50; i++) {",
          "  if (done()) return;",
          "  await act(async () => {",
          "    await sleep(5);",
          "  });",
          "}",
        ].join("\n"),
      ),
    ).toEqual([9, 10]);
  });

  test("accepts fixed-count flushes, waits on the work, and stated reasons", async () => {
    expect(
      await lintLoops(
        [
          "for (let i = 0; i < 3; i++) await Promise.resolve();",
          "for (let i = 0; i < items.length; i += 1) await Bun.sleep(1);",
          "for (let i = 0; i < action.intervals; i++) await Bun.sleep(1);",
          "for (let i = 0; i < LIMIT + 2; i++) {",
          "  if (!(await admit(async () => await Promise.resolve(i)))) break;",
          "}",
          "while (!done()) await work.next();",
          "for (const item of items) { if (item.done) break; await Bun.sleep(1); }",
          "while (!done()) {",
          "  queue.push(async () => {",
          "    if (ready()) return;",
          "  });",
          "  await queue.drain();",
          "}",
          "// real-time: the poller's own interval is under test",
          "while (!done()) await Bun.sleep(10);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("only exits targeting the observed loop turn a flush into polling", async () => {
    expect(
      await lintLoops(
        [
          "for (let i = 0; i < 3; i++) {",
          "  for (const item of items) { if (item.ready) break; }",
          '  switch (kind) { case "ready": if (ready()) break; }',
          "  local: { if (ready()) break local; }",
          "  await Promise.resolve();",
          "}",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      await lintLoops(
        [
          "outer: for (let i = 0; i < 3; i++) {",
          "  for (const item of items) { if (item.ready) break outer; }",
          "  await Promise.resolve();",
          "}",
          "for (let i = 0; i < 3; i++) {",
          "  for (const item of items) { if (item.ready) return; }",
          "  await Promise.resolve();",
          "}",
          "for (let i = 0; i < 3; i++) {",
          "  if (failed()) throw failure;",
          "  await Promise.resolve();",
          "}",
        ].join("\n"),
      ),
    ).toEqual([1, 5, 9]);
  });

  test("dormant functions do not wait while reached helpers and callbacks do", async () => {
    expect(
      await lintLoops(
        [
          'import { act as flush } from "react";',
          "while (!done()) {",
          "  const dormant = async () => { await Bun.sleep(5); };",
          "  await work.next();",
          "}",
          "const tick = async () => { await Bun.sleep(5); };",
          "while (!done()) await tick();",
          "while (!done()) await flush(tick);",
          "while (!done()) await (async () => { await Bun.sleep(5); })();",
          "while (!done()) { callbacks.push(tick); await event.next(); }",
          "while (!done()) { await Promise.resolve(tick); await event.next(); }",
          "while (!done()) { const act = (fn) => fn; await act(tick); }",
        ].join("\n"),
      ),
    ).toEqual([7, 8, 9]);
  });

  test("a deadline or an unadvanced counter is a predicate, not a pass count", async () => {
    expect(
      await lintLoops(
        [
          "while (Date.now() < deadline) await Bun.sleep(10);",
          "let attempts = 0;",
          "while (attempts < 5) await Bun.sleep(10);",
        ].join("\n"),
      ),
    ).toEqual([1, 3]);
  });
});

const lintTimeouts = lintWith("no-unreasoned-timeout");

describe("no-unreasoned-timeout", () => {
  test("reports bun:test timeouts above the default or unreadable", async () => {
    expect(
      await lintTimeouts(
        [
          'import { beforeAll, it, setDefaultTimeout, test as check, jest } from "bun:test";',
          'import * as bt from "bun:test";',
          "const BUDGET = 6 * 1000;",
          'check("a", async () => {}, 30_000);',
          'it("b", async () => {}, BUDGET);',
          "beforeAll(async () => {}, budget());",
          'bt.test.each([1])("c %d", async () => {}, { timeout: 60_000 });',
          'check("d", async () => {}, { retry: 2 });',
          "setDefaultTimeout(20_000);",
          "jest.setTimeout(10_000);",
        ].join("\n"),
      ),
    ).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  test("numeric timeout arguments need no timeout-like text", async () => {
    expect(
      await lintTimeouts(
        'import { test } from "bun:test"; test("case", () => {}, 30_000);',
      ),
    ).toEqual([1]);
  });

  test("property timeout exemptions require the canonical imported owner", async () => {
    expect(
      await lintTimeouts(
        [
          'import { test } from "bun:test";',
          "const propertyTestTimeout = () => 30_000;",
          'test("case", () => {}, propertyTestTimeout());',
        ].join("\n"),
      ),
    ).toEqual([3]);
    expect(
      await lintTimeouts(
        [
          'import { test } from "bun:test";',
          'import { propertyTestTimeout as budget } from "@stll/property-testing";',
          'import * as properties from "@stll/property-testing";',
          'test("case", () => {}, budget(30_000));',
          'test("case", () => {}, properties.propertyTestDefaultTimeout());',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("reports Playwright timeout and retry changes", async () => {
    expect(
      await lintTimeouts(
        [
          'import { test } from "@playwright/test";',
          "test.setTimeout(120_000);",
          "test.slow();",
          'test.describe.configure({ mode: "serial", retries: 2 });',
          'test("e", async ({ page }, testInfo) => {',
          "  testInfo.setTimeout(90_000);",
          "});",
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4, 6]);
  });

  test("accepts default-sized budgets, owned helpers and other APIs", async () => {
    expect(
      await lintTimeouts(
        [
          'import { describe, test } from "bun:test";',
          'import { propertyTestTimeout } from "@stll/property-testing";',
          'test("a", async () => {}, 5000);',
          'test("b", async () => {}, { timeout: 1000, retry: 0 });',
          'test("c", async () => {}, propertyTestTimeout(30_000));',
          'describe("d", () => {});',
          "socket.setTimeout(30_000);",
          'test.describe.configure({ mode: "serial" });',
          'other("e", async () => {}, 30_000);',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("accepts a timeout or quarantine reason at the call or its argument", async () => {
    expect(
      await lintTimeouts(
        [
          'import { test } from "bun:test";',
          "// timeout: spawns a real Postgres cluster",
          'test("a", async () => {}, 30_000);',
          'test("b", async () => {',
          "  await work();",
          "}, 30_000); // timeout: measured 12 s on the slowest runner",
          "// quarantine: #1234",
          'test("c", async () => {}, 30_000);',
          "// Takes a while.",
          'test("d", async () => {}, 30_000);',
          "// quarantine: soon",
          'test("e", async () => {}, 30_000);',
        ].join("\n"),
      ),
    ).toEqual([10, 12]);
  });
});

describe("tagged reasons", () => {
  test("a tagged reason needs the tag and a word", () => {
    const reason = taggedComment(["real-time"]);
    expect(reason.test(" real-time: pacing under test")).toBe(true);
    expect(reason.test(" real-time: x")).toBe(false);
    expect(reason.test(" note real-time: pacing under test")).toBe(false);
    expect(reason.test(" wait for the worker")).toBe(false);
  });
});

const lintLiteralWaitTimeouts = lintWith("no-literal-wait-timeout");

describe("no-literal-wait-timeout", () => {
  test("reports Testing Library wait and query timeouts", async () => {
    expect(
      await lintLiteralWaitTimeouts(
        [
          "const SHORT = 500 * 2;",
          "await waitFor(ready, { timeout: 1000 });",
          "await testing.waitForElementToBeRemoved(gone, { timeout: SHORT });",
          'await screen.findByText("done", undefined, { timeout: 2_000 });',
          'await within(panel).findAllByRole("row", {}, { timeout: SHORT + 1 });',
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4, 5]);
  });

  test("reports Playwright poll, toPass and locator assertion timeouts", async () => {
    expect(
      await lintLiteralWaitTimeouts(
        [
          'import { expect } from "@playwright/test";',
          "const COLD_COMPILE_TIMEOUT = 60_000;",
          "await expect.poll(read, { timeout: 1000 }).toBe(true);",
          "await expect(async () => work()).toPass({ timeout: 2000 });",
          "await expect(page.getByRole('button')).toBeVisible({ timeout: 3000 });",
          "await expect(locator).toHaveText('done', { timeout: 4000 });",
          "await expect(locator).toBeVisible({ timeout: 30 * 1000 });",
          "await expect(locator).toBeVisible({ timeout: COLD_COMPILE_TIMEOUT });",
        ].join("\n"),
      ),
    ).toEqual([3, 4, 5, 6, 7]);
  });

  test("reports every DOM timeout but accepts named Playwright budgets", async () => {
    expect(
      await lintLiteralWaitTimeouts(
        [
          'import { expect } from "@playwright/test";',
          "await waitFor(ready, { timeout: sharedTimeout });",
          "await request({ timeout: 1000 });",
          "await expect.poll(read, { timeout: COLD_COMPILE_TIMEOUT }).toBe(true);",
          "await screen.findByText('done', undefined, { timeout: SOME_CONSTANT });",
        ].join("\n"),
      ),
    ).toEqual([2, 5]);
  });
});
