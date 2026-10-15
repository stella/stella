import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects direct storage reads through fallbacks and wrappers", async () => {
  expect(
    await lintSingleRule(
      "no-raw-stored-json",
      'JSON.parse(localStorage.getItem("k"));\nJSON.parse(window.sessionStorage.getItem("k") ?? "null");\nJSON.parse(localStorage.getItem("k")!);',
    ),
  ).toEqual([1, 2, 3]);
});

test("tracks storage variables into nested lexical functions", async () => {
  expect(
    await lintSingleRule(
      "no-raw-stored-json",
      'const raw = window.localStorage.getItem("k");\nJSON.parse(raw ?? "null");\nfunction nested() { JSON.parse(raw); }',
    ),
  ).toEqual([2, 3]);
});

test("does not confuse shadowed parameters or unrelated sibling functions with stored data", async () => {
  expect(
    await lintSingleRule(
      "no-raw-stored-json",
      'const raw = localStorage.getItem("k");\nfunction safe(raw) { JSON.parse(raw); }\nfunction first() { const sibling = sessionStorage.getItem("k"); }\nfunction second() { JSON.parse(sibling); }',
    ),
  ).toEqual([]);
});

test("accepts schema-validated storage and nonstorage JSON sources", async () => {
  expect(
    await lintSingleRule(
      "no-raw-stored-json",
      'readStoredJson(localStorage.getItem("k"), schema);\nJSON.parse(eventData);\nconst raw = otherStorage.getItem("k");\nJSON.parse(raw);',
    ),
  ).toEqual([]);
});
