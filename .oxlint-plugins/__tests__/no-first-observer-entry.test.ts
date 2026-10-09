import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(30_000);

const lint = async (source: string) =>
  await lintSingleRule("no-first-observer-entry", source);

describe("observer callbacks decide from the latest record", () => {
  test("rejects first-record reads for either observer and any parameter name", async () => {
    expect(
      await lint(
        [
          "new IntersectionObserver((records) => consume(records[0]));",
          "new ResizeObserver(function (measurements) { consume(measurements.at(0)); });",
          "new window.IntersectionObserver((queue) => consume(queue?.at(0)));",
          'new globalThis.ResizeObserver((batch) => consume(batch["at"](0)));',
          "new ResizeObserver((records = []) => consume(records[0]));",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("follows named callbacks declared before or after construction and stable aliases", async () => {
    expect(
      await lint(
        [
          "const callback = (records) => consume(records[0]);",
          "const alias = callback; new ResizeObserver(alias);",
          "new IntersectionObserver(onIntersection);",
          "function onIntersection(records) { consume(records.at(0)); }",
        ].join("\n"),
      ),
    ).toEqual([1, 4]);
  });

  test("follows a function declaration only while its binding is never reassigned", async () => {
    // Reassigned before construction: the observer receives the latest callback.
    expect(
      await lint(
        [
          "function onResize(records) { consume(records[0]); }",
          "onResize = (records) => consume(records.at(-1));",
          "new ResizeObserver(onResize);",
        ].join("\n"),
      ),
    ).toEqual([]);
    // Reassigned after construction in source order: loops and closures can
    // still run the write first, so the declaration is not followed either.
    expect(
      await lint(
        [
          "new IntersectionObserver(onIntersection);",
          "onIntersection = (records) => consume(records.at(-1));",
          "function onIntersection(records) { consume(records[0]); }",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      await lint(
        [
          "new IntersectionObserver(onIntersection);",
          "function onIntersection(records) { consume(records[0]); }",
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  test("rejects first-record destructuring in either observer callback", async () => {
    expect(
      await lint(
        [
          "new ResizeObserver(([first]) => consume(first));",
          "new IntersectionObserver(function ([entry, ...rest]) { consume(entry); });",
          "new ResizeObserver((entries) => { const [first] = entries; consume(first); });",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3]);
  });

  test("allows shadowed and non-first callback-body destructuring", async () => {
    expect(
      await lint(
        [
          "new ResizeObserver((entries) => { { const entries = unrelated; const [first] = entries; consume(first); } });",
          "new ResizeObserver((entries) => { const [, second] = entries; consume(second); });",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("allows rest destructuring of all observer entries", async () => {
    expect(
      await lint(
        [
          "new ResizeObserver(([...entries]) => consume(entries));",
          "new ResizeObserver((entries) => { const [...copy] = entries; consume(copy); });",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("tracks lexical bindings through nested callbacks without confusing shadowed arrays", async () => {
    expect(
      await lint(
        [
          "new ResizeObserver((records) => {",
          "  consume(() => records[0]);",
          "  consume((records) => records[0]);",
          "  { const records = unrelated; consume(records.at(0)); }",
          "});",
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  test("allows latest single-target records, per-target folding and unrelated arrays", async () => {
    expect(
      await lint(
        [
          "new IntersectionObserver((entries) => consume(entries.at(-1)));",
          "new ResizeObserver((entries) => { const latest = new Map(); for (const entry of entries) latest.set(entry.target, entry); consume(latest); });",
          "new ResizeObserver((entries) => consume(unrelated[0]));",
          "consume((entries) => entries.at(0));",
          "function local(ResizeObserver) { new ResizeObserver((entries) => entries[0]); }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("the committed fixture plants violations and permits latest-per-target decisions", async () => {
    const fixture = readFileSync(
      new URL(
        "../__fixtures__/no-first-observer-entry.fixture.ts",
        import.meta.url,
      ),
      "utf-8",
    );
    const planted = fixture.replaceAll(
      /.*oxlint-disable-next-line.*\n/gu,
      "\n",
    );
    expect(planted).not.toBe(fixture);
    expect(await lint(fixture)).toEqual([]);
    const violations = fixture
      .split("\n")
      .flatMap((line, index) =>
        line.includes("oxlint-disable-next-line no-first-observer-entry/")
          ? [index + 2]
          : [],
      );
    expect(violations).toHaveLength(2);
    expect(await lint(planted)).toEqual(violations);
  });
});
