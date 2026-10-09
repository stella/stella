import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports discarded escaped and retained URLs", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "URL.createObjectURL(blob);\nfunction escaped() { return globalThis.URL.createObjectURL(blob); }\nfunction retained() { const url = URL.createObjectURL(blob); return url; }",
      {},
    ),
  ).toEqual([1, 2, 3]);
});

test("requires revocation of the created value", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function wrong() { const url = URL.createObjectURL(blob); URL.revokeObjectURL(other); }",
      {},
    ),
  ).toEqual([1]);
});

test("rejects conditional and early return cleanup paths", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function conditional() { const url = URL.createObjectURL(blob); if (condition) URL.revokeObjectURL(url); }\nfunction early() { const url = URL.createObjectURL(blob); if (condition) return; URL.revokeObjectURL(url); }",
      {},
    ),
  ).toEqual([1, 2]);
});

test("accepts immutable aliases and returned cleanup ownership", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function direct() { const url = window.URL.createObjectURL(blob); const alias = url; window.URL.revokeObjectURL(alias); }\nfunction cleanup() { const url = URL.createObjectURL(blob); return () => URL.revokeObjectURL(url); }",
      {},
    ),
  ).toEqual([]);
});

test("accepts unconditional finally and scheduled cleanup", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function final() { const url = URL.createObjectURL(blob); try { consume(url); } finally { URL.revokeObjectURL(url); } }\nfunction scheduled() { const url = URL.createObjectURL(blob); const cleanup = () => URL.revokeObjectURL(url); setTimeout(cleanup, 1000); }",
      {},
    ),
  ).toEqual([]);
});

test("does not treat an overwritten binding as disposed", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function overwritten() { let url = URL.createObjectURL(blob); url = other; URL.revokeObjectURL(url); }",
      {},
    ),
  ).toEqual([1]);
});

test("respects local URL and host shadows", async () => {
  expect(
    await lintSingleRule(
      "no-object-url-leak",
      "function local(URL, window) { URL.createObjectURL(blob); window.URL.createObjectURL(blob); }",
      {},
    ),
  ).toEqual([]);
});
