import { describe, expect, test } from "bun:test";

import { mergeLegacyLawHistory } from "@/lib/account/law-history-legacy-merge";
import {
  lawRecentKey,
  readLawRecent,
} from "@/lib/law-search-history/law-search-history.rows";
import type { LawRecentEntry } from "@/lib/law-search-history/law-search-history.schema";

const scoped = {
  kind: "search",
  query: "damages",
  at: "2026-01-01T10:00:00Z",
} satisfies LawRecentEntry;

const merge = (legacy: unknown[], existing: unknown[] = [scoped]) =>
  readLawRecent(
    mergeLegacyLawHistory(JSON.stringify(legacy), JSON.stringify(existing)),
  );

describe("legacy law history adoption", () => {
  test.each(["2026-01-01T09:30:00-02:00", "2026-01-01T10:00:00.000000001Z"])(
    "keeps the chronologically newest duplicate at %s",
    (at) => {
      const entries = merge([{ query: scoped.query, at }]);
      expect(entries).toEqual([{ ...scoped, at }]);
    },
  );

  test.each([
    { kind: "search", query: scoped.query, at: "z" },
    { kind: "search", query: scoped.query, at: "2026-02-30T00:00:00Z" },
    { kind: "unsupported", query: scoped.query, at: "2026-01-02T00:00:00Z" },
    { kind: "decision", query: scoped.query, at: "2026-01-02T00:00:00Z" },
    { query: " ", at: "2026-01-02T00:00:00Z" },
  ])("invalid rows cannot evict valid scoped history: %j", (invalid) => {
    // Include a valid unrelated row so adoption still writes the merged store.
    const unrelated = {
      kind: "search",
      query: "contracts",
      at: scoped.at,
    } satisfies LawRecentEntry;
    expect(merge([invalid, unrelated])).toEqual([scoped, unrelated]);
    expect(
      mergeLegacyLawHistory(
        JSON.stringify([invalid]),
        JSON.stringify([scoped]),
      ),
    ).toBeNull();
  });

  test("opened entries use kind and id even when raw rows contain query fields", () => {
    const decision = {
      kind: "decision",
      id: "decision-1",
      title: "Decision",
      path: "/law/cz/cases/supreme/decision-1",
      at: scoped.at,
    };
    const statute = {
      kind: "statute",
      id: decision.id,
      title: "Statute",
      path: "/law/cz/statutes/statute-1",
      at: scoped.at,
    };
    const newestDecision = { ...decision, at: "2026-01-02T00:00:00Z" };
    const entries = merge(
      [{ ...newestDecision, query: scoped.query }, statute],
      [scoped, { ...decision, query: "unrelated" }],
    );
    expect(entries.map(lawRecentKey)).toEqual([
      "decision:decision-1",
      "search:damages",
      "statute:decision-1",
    ]);
    expect(entries.at(0)).toMatchObject(newestDecision);
  });

  test("normalizes legacy searches before deduplicating and is idempotent", () => {
    const raw = mergeLegacyLawHistory(
      JSON.stringify([{ query: " damages ", at: scoped.at }]),
      JSON.stringify([scoped]),
    );
    expect(readLawRecent(raw)).toEqual([scoped]);
    expect(mergeLegacyLawHistory(JSON.stringify([scoped]), raw)).toBe(raw);
  });
});
