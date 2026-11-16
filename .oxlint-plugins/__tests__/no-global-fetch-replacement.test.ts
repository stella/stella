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
        'test("outside", () => { const original = globalThis.fetch; globalThis.fetch = fakeFetch; try { run(); } finally { globalThis.fetch = original; } });',
        'test("helper", () => { const original = globalThis.fetch; const run = () => { try { globalThis.fetch = fakeFetch; } finally { globalThis.fetch = original; } }; run(); });',
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
        'check.each([1, 2])("local", () => { const original = globalThis.fetch; try { globalThis.fetch = fakeFetch; } finally { globalThis.fetch = original; } });',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("rejects fake restoration and unrelated spy restoration", async () => {
  expect(
    await lint(
      [
        'import { test, spyOn } from "bun:test";',
        'test("fake", () => { try { globalThis.fetch = fake; } finally { globalThis.fetch = fake; } });',
        'test("unrelated", () => { const spy = spyOn(console, "log"); try { globalThis.fetch = fake; } finally { spy.mockRestore(); } });',
        'test("other spy", () => { const spy = spyOn(console, "log"); const fetchSpy = spyOn(globalThis, "fetch"); try { run(); } finally { spy.mockRestore(); } });',
      ].join("\n"),
    ),
  ).toEqual([2, 2, 3, 4]);
});

test("requires the saved fetch binding to precede the replacement", async () => {
  expect(
    await lint(
      [
        'import { test } from "bun:test";',
        'test("late", () => { try { globalThis.fetch = fake; const original = globalThis.fetch; } finally { globalThis.fetch = original; } });',
        'test("shadowed", () => { const original = globalThis.fetch; try { globalThis.fetch = fake; } finally { const original = fake; globalThis.fetch = original; } });',
        'test("reassigned", () => { let original = globalThis.fetch; original = fake; try { globalThis.fetch = fake; } finally { globalThis.fetch = original; } });',
        'test("spy captured late", () => { const spy = spyOn(globalThis, "fetch"); const original = globalThis.fetch; try { run(); } finally { globalThis.fetch = original; } });',
      ].join("\n"),
    ),
  ).toEqual([2, 2, 3, 3, 4, 4, 5]);
});

test("matches restored spies through import and local aliases", async () => {
  expect(
    await lint(
      [
        'import { test, spyOn as watch } from "bun:test";',
        'test("matching", () => { const spy = watch(globalThis, "fetch"); const alias = spy; try { run(); } finally { alias.mockRestore(); } });',
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
