import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-global-fetch-replacement";
const lint = async (source: string) =>
  lintSingleRule(RULE, source, {
    sourcePath: "apps/api/src/example.test.ts",
  });

test("rejects suite, hook and helper mutations", async () => {
  expect(
    await lint(
      [
        'import { beforeEach, test } from "bun:test";',
        "beforeEach(() => { globalThis.fetch = fakeFetch; });",
        'test("helper", () => { const replace = () => { globalThis.fetch = fakeFetch; }; replace(); });',
      ].join("\n"),
    ),
  ).toEqual([2, 3]);
});

test("allows test-local try/finally restoration", async () => {
  expect(
    await lint(
      [
        'import { test } from "bun:test";',
        'test("local", () => {',
        "  const original = globalThis.fetch;",
        "  try { globalThis.fetch = fakeFetch; } finally { globalThis.fetch = original; }",
        "});",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("rejects a test mutation without restoration and allows restored spies", async () => {
  expect(
    await lint(
      [
        'import { test } from "bun:test";',
        'test("unrestored", () => { spyOn(globalThis, "fetch"); });',
        'test("restored", () => { const spy = spyOn(globalThis, "fetch"); try { run(); } finally { spy.mockRestore(); } });',
      ].join("\n"),
    ),
  ).toEqual([2]);
});

test("a nearby finally does not authorize helpers or an assignment outside its try", async () => {
  expect(
    await lint(
      [
        'import { test } from "bun:test";',
        'test("outside", () => { globalThis.fetch = fakeFetch; try { run(); } finally { globalThis.fetch = original; } });',
        'test("helper", () => { const run = () => { try { globalThis.fetch = fakeFetch; } finally { globalThis.fetch = original; } }; run(); });',
        'Object.defineProperty(globalThis, "fetch", { value: fakeFetch });',
      ].join("\n"),
    ),
  ).toEqual([2, 3, 3, 4]);
});

test("recognizes aliased parameterized test callbacks", async () => {
  expect(
    await lint(
      [
        'import { test as check } from "bun:test";',
        'check.each([1, 2])("local", () => { try { globalThis.fetch = fakeFetch; } finally { globalThis.fetch = original; } });',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("rejects aliased spies and reflective descriptor replacement", async () => {
  expect(
    await lint(
      [
        'import { spyOn as spy } from "bun:test";',
        'spy(globalThis, "fetch");',
        'Reflect.defineProperty(globalThis, "fetch", { value: fakeFetch });',
      ].join("\n"),
    ),
  ).toEqual([2, 3]);
});
