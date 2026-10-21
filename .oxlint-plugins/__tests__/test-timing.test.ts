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

describe("tagged reasons", () => {
  test("a tagged reason needs the tag and a word", () => {
    const reason = taggedComment(["real-time"]);
    expect(reason.test(" real-time: pacing under test")).toBe(true);
    expect(reason.test(" real-time: x")).toBe(false);
    expect(reason.test(" note real-time: pacing under test")).toBe(false);
    expect(reason.test(" wait for the worker")).toBe(false);
  });
});
