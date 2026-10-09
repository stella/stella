import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-known-value-widening", () => {
  test("reports broad types erasing known local values", async () => {
    expect(
      await lintSingleRule(
        "no-known-value-widening",
        'const data: unknown = { id: "a" };\nconst other = [1, 2] as object;',
      ),
    ).toEqual([1, 2]);
  });
  test("follows constant and type aliases", async () => {
    expect(
      await lintSingleRule(
        "no-known-value-widening",
        'type Broad = unknown;\nconst source = { id: "a" };\nconst alias = source;\nconst data: Broad = alias;',
      ),
    ).toEqual([4]);
  });
  test("accepts unknown API and mutable boundaries", async () => {
    expect(
      await lintSingleRule(
        "no-known-value-widening",
        'const data: unknown = await request();\nlet source = { id: "a" };\nconst other: unknown = source;',
      ),
    ).toEqual([]);
  });
  test("accepts values crossing a declared call contract", async () => {
    expect(
      await lintSingleRule(
        "no-known-value-widening",
        'const data: unknown = { id: "a" };\nvalidate(data);',
      ),
    ).toEqual([]);
  });
  test("accepts satisfies without losing local evidence", async () => {
    expect(
      await lintSingleRule(
        "no-known-value-widening",
        'const data = { id: "a" } satisfies Record<string, unknown>;',
      ),
    ).toEqual([]);
  });
  test("accepts locally shadowed type aliases and Record contracts", async () => {
    expect(
      await lintSingleRule(
        "no-known-value-widening",
        'type Broad = unknown;\nfunction local() { type Broad = { id: string }; const data: Broad = { id: "a" }; }\nfunction custom() { type Record<K, V> = { id: string }; const data: Record<string, unknown> = { id: "a" }; }',
      ),
    ).toEqual([]);
  });
  test("reports open dictionaries when a later narrowing discards the broad contract", async () => {
    expect(
      await lintSingleRule(
        "no-known-value-widening",
        'const record: Record<string, unknown> = { id: "a" };\nconst narrowed = record as { id: string };\nconst indexed: { [key: string]: unknown } = { id: "b" };\nconst other = indexed as { id: string };',
      ),
    ).toEqual([1, 3]);
  });
  test("accepts open dictionaries without a narrower consumer", async () => {
    expect(
      await lintSingleRule(
        "no-known-value-widening",
        'const record: Record<string, unknown> = { id: "a" };\nconst indexed: { [key: string]: unknown } = { id: "b" };',
      ),
    ).toEqual([]);
  });
});
