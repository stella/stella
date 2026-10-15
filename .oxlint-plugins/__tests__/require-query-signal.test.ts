import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports browser requests without cancellation", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      'const a = { queryKey: ["a"], queryFn: () => fetch("/a") };\nconst b = { queryKey: ["b"], queryFn: () => window.fetch("/b") };',
      {},
    ),
  ).toEqual([1, 2]);
});

test("requires threading the destructured signal into request options", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      'const a = { queryKey: ["a"], queryFn: ({ signal }) => fetch("/a", { signal: other }) };',
      {},
    ),
  ).toEqual([1]);
});

test("checks imported Eden API requests", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      'import { api as client } from "@/lib/api";\nconst a = { queryKey: ["a"], queryFn: () => client.example.get() };',
      {},
    ),
  ).toEqual([2]);
});

test("allows signal aliases in fetch and Eden options", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      'import { api } from "@/lib/api";\nconst a = { queryKey: ["a"], queryFn: ({ signal: abort }) => fetch("/a", { signal: abort }) };\nconst b = { queryKey: ["b"], queryFn: ({ signal }) => api.example.get({ fetch: { signal } }) };',
      {},
    ),
  ).toEqual([]);
});

test("resolves stable local function and alias query functions", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      'function request() { return fetch("/a"); }\nconst alias = request;\nconst a = { queryKey: ["a"], queryFn: alias };',
      {},
    ),
  ).toEqual([1]);
});

test("keeps imported mutable and nested helper requests opaque", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      'import { request } from "./request";\nconst a = { queryKey: ["a"], queryFn: request };\nlet mutable = () => fetch("/a");\nconst b = { queryKey: ["b"], queryFn: mutable };\nconst c = { queryKey: ["c"], queryFn: () => { const later = () => fetch("/c"); return later; } };',
      {},
    ),
  ).toEqual([]);
});

test("ignores local fetch bindings and objects without query keys", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      'function local(fetch) { return { queryKey: ["a"], queryFn: () => fetch("/a") }; }\nconst a = { queryFn: () => fetch("/a") };',
      {},
    ),
  ).toEqual([]);
});

test("requires cancellation for every direct request", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      `const options = { queryKey: ["a"], queryFn: async ({ signal }) => {
await fetch("/a", { signal });
return fetch("/b");
} };`,
    ),
  ).toEqual([3]);
});
test("allows every direct request to use the query signal", async () => {
  expect(
    await lintSingleRule(
      "require-query-signal",
      `const options = { queryKey: ["a"], queryFn: async ({ signal }) => {
await fetch("/a", { signal });
return fetch("/b", { signal });
} };`,
    ),
  ).toEqual([]);
});
