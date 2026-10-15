import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-network-await-in-loop", () => {
  test("reports loop bodies tests and updates", async () => {
    expect(
      await lintSingleRule(
        "no-network-await-in-loop",
        "async function load() { for (const id of ids) { await fetch(url); }\nwhile (await window.fetch(url)) {}\nfor (; active; await self.fetch(url)) {} }",
      ),
    ).toEqual([1, 2, 3]);
  });
  test("reports imported aliases and computed client routes", async () => {
    expect(
      await lintSingleRule(
        "no-network-await-in-loop",
        'import { fetchWithTimeout as request } from "@stll/fetch";\nimport { api } from "@/lib/eden-client";\nasync function load() { for (const id of ids) { await request(url); await api["copy-to-workspace"].post({ id }); } }',
      ),
    ).toEqual([3, 3]);
  });
  test("reports AWS command dispatch and Result boundaries", async () => {
    expect(
      await lintSingleRule(
        "no-network-await-in-loop",
        'import { Result } from "better-result";\nasync function load() { for (const id of ids) { await client.send(new GetObjectCommand({ id })); await Result.tryPromise(async () => await fetch(url)); } }\nfunction* read() { for (const id of ids) { yield* Result.await(fetch(url)); } }',
      ),
    ).toEqual([2, 2, 3]);
  });
  test("accepts one time loop positions and deferred functions", async () => {
    expect(
      await lintSingleRule(
        "no-network-await-in-loop",
        "async function load() { for (const id of await fetch(url)) { const next = async () => await fetch(url); }\nfor (let page = await fetch(url); active;) { consume(page); } }",
      ),
    ).toEqual([]);
  });
  test("accepts batched and unrelated local operations", async () => {
    expect(
      await lintSingleRule(
        "no-network-await-in-loop",
        "async function load() { await Promise.all(ids.map(id => fetch(url))); for (const id of ids) { await transport.send(message); await fetchSomething(id); } }",
      ),
    ).toEqual([]);
  });
});
