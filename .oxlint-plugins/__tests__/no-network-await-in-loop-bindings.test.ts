import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("keeps actual global fetch calls network bound", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      "async function load() { for (const id of ids) {\nawait fetch(id);\nawait globalThis.fetch(id);\nawait window.fetch(id);\nawait self.fetch(id);\n} }",
    ),
  ).toEqual([2, 3, 4, 5]);
});
test("keeps imported aliases namespaces and fluent clients network bound", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'import { fetchWithTimeout as read } from "@stll/fetch";\nimport * as http from "@stll/fetch";\nimport { api as client } from "@/lib/eden-client";\nasync function load() { for (const id of ids) {\nawait read(id);\nawait http.fetchWithTimeout(id);\nawait client.documents({ id }).get();\nawait client["copy-to-workspace"].post({ id });\n} }',
    ),
  ).toEqual([5, 6, 7, 8]);
});
test("ignores parameters shadowing global fetch names", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      "async function load(fetch, globalThis, window, self) { for (const id of ids) { await fetch(id); await globalThis.fetch(id); await window.fetch(id); await self.fetch(id); } }",
    ),
  ).toEqual([]);
});
test("ignores parameters shadowing imported owners", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'import { fetchWithTimeout as read } from "@stll/fetch";\nimport { api } from "@/lib/eden-client";\nasync function load(read, api) { for (const id of ids) { await read(id); await api.documents.get(id); } }',
    ),
  ).toEqual([]);
});
test("ignores block scoped shadows without hiding later imports", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'import { fetchWithTimeout as read } from "@stll/fetch";\nimport { api } from "@/lib/eden-client";\nasync function load() { for (const id of ids) {\n{ const read = localRead; const api = localClient; await read(id); await api.documents.get(id); }\nawait read(id); await api.documents.get(id);\n} }',
    ),
  ).toEqual([5, 5]);
});
test("resolves hoisted declarations before their source order", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'import { fetchWithTimeout as read } from "@stll/fetch";\nimport { api } from "@/lib/eden-client";\nasync function load() { for (const id of ids) { await read(id); await api.get(id); await fetch(id); }\nfunction read(id) { return id; }\nvar api;\nfunction fetch(id) { return id; } }',
    ),
  ).toEqual([]);
});
test("recognizes imports written after their call site", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'async function load() { for (const id of ids) { await read(id); } }\nimport { fetchWithTimeout as read } from "@stll/fetch";',
    ),
  ).toEqual([1]);
});
test("preserves command dispatch and Result loop boundaries", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'import { Result } from "better-result";\nimport { fetchWithTimeout as read } from "@stll/fetch";\nasync function load() { for (const id of ids) { await client.send(new GetObjectCommand({ id })); await Result.tryPromise(async () => await read(id)); } }\nfunction* loadResult() { for (const id of ids) { yield* Result.await(read(id)); } }',
    ),
  ).toEqual([3, 3, 4]);
});
test("leaves one time positions and deferred work outside the loop budget", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'import { fetchWithTimeout as read } from "@stll/fetch";\nasync function load() { for (const id of await read(url)) { const task = async () => await read(id); } for (let result = await read(url); active;) consume(result); }',
    ),
  ).toEqual([]);
});
test("does not infer network ownership from unrelated modules", async () => {
  expect(
    await lintSingleRule(
      "no-network-await-in-loop",
      'import { fetchWithTimeout as read } from "other-library";\nimport { api } from "./client";\nasync function load() { for (const id of ids) { await read(id); await api.documents.get(id); await transport.send(message); } }',
    ),
  ).toEqual([]);
});
