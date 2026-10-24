import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (...lines: readonly string[]) =>
  await lintSingleRule("no-polling-loop", [...lines, ""].join("\n"), {
    plugin: "bun-test-hygiene",
    sourcePath: "polling.test.ts",
  });

describe("no-polling-loop", () => {
  test("rejects a loop that waits until a predicate holds", async () => {
    expect(
      await lint(
        "declare const done: () => boolean;",
        "const run = async () => {",
        "  while (!done()) { await Bun.sleep(5); }",
        "  for (let i = 0; i < 9; i += 1) { if (done()) break; await Bun.sleep(5); }",
        "  for (let i = 0; i < 9 && !done(); i += 1) { await Bun.sleep(5); }",
        "  do { await Promise.resolve(); } while (!done());",
        "  while (Date.now() < 1) { if (done()) { return; } await Bun.sleep(5); }",
        "};",
      ),
    ).toEqual([3, 4, 5, 6, 7]);
  });

  test("resolves waits through their imports, aliases and namespaces", async () => {
    expect(
      await lint(
        'import { sleep } from "bun";',
        'import { sleep as pause } from "@stll/concurrency/sleep";',
        'import { nextMacrotask } from "@stll/concurrency/event-loop";',
        'import * as timers from "node:timers/promises";',
        'import { setImmediate as tick } from "timers/promises";',
        "declare const done: () => boolean;",
        "const run = async () => {",
        "  while (!done()) { await sleep(1); }",
        "  while (!done()) { await pause(1); }",
        "  while (!done()) { await nextMacrotask(); }",
        "  while (!done()) { await timers.setTimeout(1); }",
        "  while (!done()) { await tick(); }",
        "};",
      ),
    ).toEqual([8, 9, 10, 11, 12]);
  });

  test("recognizes timer promises and local helpers that only wait", async () => {
    expect(
      await lint(
        "declare const done: () => boolean;",
        "const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));",
        "async function yieldTurn() { await new Promise(setImmediate); }",
        "const pause = async (ms: number) => await Bun.sleep(ms);",
        "const run = async () => {",
        "  while (!done()) { await new Promise((r) => setTimeout(r, 5)); }",
        "  while (!done()) { await wait(5); }",
        "  while (!done()) { await yieldTurn(); }",
        "  while (!done()) { await pause(5); }",
        "};",
      ),
    ).toEqual([6, 7, 8, 9]);
  });

  test("accepts fixed-count flushes, callbacks, sequences and non-waits", async () => {
    expect(
      await lint(
        "declare const done: () => boolean;",
        "declare const work: () => Promise<void>;",
        "declare const chunks: AsyncIterable<string>;",
        "declare const later: (run: () => Promise<void>) => void;",
        "const helper = async (ms: number) => { await work(); await Bun.sleep(ms); };",
        "const run = async (count: string) => {",
        "  for (let i = 0; i < 3; i += 1) { await Bun.sleep(0); }",
        "  for (let i = 0; i < Number(count); i += 1) { await Bun.sleep(1); }",
        "  while (true) { await Bun.sleep(5); }",
        "};",
        "const other = async () => {",
        "  while (!done()) { later(async () => { await Bun.sleep(1); }); }",
        "  while (!done()) { await work(); }",
        "  while (!done()) { await helper(1); }",
        "  for await (const chunk of chunks) { if (chunk) break; await Bun.sleep(1); }",
        "};",
      ),
    ).toEqual([]);
  });

  test("ignores a local binding that shadows a runtime global", async () => {
    expect(
      await lint(
        "declare const done: () => boolean;",
        "const run = async (Bun: { sleep: (ms: number) => Promise<void> }) => {",
        "  while (!done()) { await Bun.sleep(5); }",
        "};",
      ),
    ).toEqual([]);
  });
});
