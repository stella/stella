import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import exceptions from "../no-hand-rolled-concurrency-exceptions.json" with { type: "json" };
import { lintSingleRule, runSingleRule } from "./lint-single-rule.ts";

const rule = "no-hand-rolled-concurrency";

test("each exception reaches exactly one diagnostic in its current source", async () => {
  for (const entry of exceptions) {
    const source = readFileSync(entry.path, "utf-8");
    const raw = await runSingleRule(rule, source, { sourcePath: entry.path });
    expect(raw.lines).toHaveLength(1);
    expect(
      (
        await runSingleRule(rule, source, {
          sourcePath: entry.path,
          ruleOptions: { exceptions: [entry] },
        })
      ).lines,
    ).toEqual([]);
  }
});

test("reports direct resolver delays and named sleep implementations", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        "const wait = (ms) => new Promise(r => setTimeout(r, ms));",
        "const waitBlock = (ms) => new Promise(done => { setTimeout(done, ms); });",
        "const delay = (ms) => new Promise(resolve => { const timer = setTimeout(() => resolve(), ms); });",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3]);
});

test("reports named duplicate partition and backoff helpers at their owners", async () => {
  for (const [sourcePath, source] of [
    [
      "apps/api/src/lib/chunked.ts",
      "export const chunked = (items,size) => [];",
    ],
    [
      "apps/web/src/features/case-law/research/queries.ts",
      "const chunk = (items,size) => [];",
    ],
    [
      "apps/api/src/handlers/case-law/ingestion/adapters/retry.ts",
      "export function backoffMs(attempt) { return 1000; }",
    ],
  ] as const) {
    expect((await runSingleRule(rule, source, { sourcePath })).lines).toEqual([
      1,
    ]);
  }
});

test("allows native delays, lifecycle timers, math and domain slices", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        'import { sleep } from "@stll/concurrency/sleep";',
        'import { backoffDelay } from "@stll/concurrency/backoff-delay";',
        'import { chunk } from "@stll/concurrency/chunk";',
        "await sleep(1000); await Bun.sleep(1000);",
        "backoffDelay(3, {baseMs:1000});",
        "for (const batch of chunk(items,10)) consume(batch);",
        "const squared = length ** 2;",
        "setTimeout(refresh, 1000);",
        "const deadline = new Promise(resolve => { timer = setTimeout(resolve, ms); });",
        "const page = items.slice(offset, offset+size);",
        "for (let i=0;i<text.length;i+=2) consume(text.slice(i,i+2));",
        "for (let i=0;i<items.length;i+=step) consume(items.slice(i,i+windowSize));",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("does not confuse shadowed APIs with native delays", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        "const setTimeout = customSchedule;",
        "new Promise(r => setTimeout(r, 10));",
        "const window = fakeWindow;",
        "new Promise(r => window.setTimeout(r, 10));",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("owner exemption and exceptions are bounded to one exact file and expression", async () => {
  const source =
    "new Promise(r => setTimeout(r, 10));\nnew Promise(r => setTimeout(r, 10));";
  expect(
    (
      await runSingleRule(rule, source, {
        sourcePath: "packages/concurrency/src/source.ts",
      })
    ).lines,
  ).toEqual([]);
  expect(
    (
      await runSingleRule(rule, source, {
        sourcePath: "packages/public/src/source.ts",
        ruleOptions: {
          exceptions: [
            {
              path: "packages/public/src/source.ts",
              source: "setTimeout(r, 10)",
              reason: "Published package has no owner dependency",
            },
          ],
        },
      })
    ).lines,
  ).toEqual([2]);
  expect(
    (
      await runSingleRule(rule, source, {
        sourcePath: "packages/other/src/source.ts",
        ruleOptions: {
          exceptions: [
            {
              path: "packages/public/src/source.ts",
              source: "setTimeout(r, 10)",
              reason: "Published package has no owner dependency",
            },
          ],
        },
      })
    ).lines,
  ).toEqual([1, 2]);
});
