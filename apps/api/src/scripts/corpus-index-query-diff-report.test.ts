import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import {
  diffRankedDocuments,
  divergedQueries,
  type GoldenQueryDiffRow,
  parseGoldenQueryFile,
  type QueryRunOutcome,
  rankDocumentHits,
  renderDiffTable,
} from "@/api/scripts/corpus-index-query-diff-report";

const outcome = (
  rankedDocumentIds: readonly string[],
  totalHits = rankedDocumentIds.length,
): QueryRunOutcome => ({
  totalHits,
  rankedDocumentIds,
  unidentifiedHits: 0,
});

const unwrap = <T>(result: Result<T, { message: string }>): T => {
  if (Result.isError(result)) {
    panic(result.error.message);
  }
  return result.value;
};

describe("parseGoldenQueryFile", () => {
  test("the committed sample parses and exercises the curated query classes", async () => {
    const content = await Bun.file(
      `${import.meta.dir}/corpus-index-query-diff.sample.json`,
    ).text();
    const queries = unwrap(parseGoldenQueryFile(content));

    // Each curated class must stay represented, or the sample silently
    // stops covering what it exists to cover. The phrase check uses the
    // production tokenizer as the oracle rather than re-reading quotes.
    expect(
      queries.some((query) =>
        tokenizeCorpusFreeText(query.text).some(
          (token) => token.type === "phrase",
        ),
      ),
    ).toBe(true);
    // Diacritic coverage: at least one query text must leave printable
    // ASCII, so a simplified sample cannot silently drop the class.
    expect(queries.some((query) => /[^\u0020-\u007e]/u.test(query.text))).toBe(
      true,
    );
    expect(
      queries.some(
        (query) =>
          query.filters?.dateFrom !== undefined &&
          query.filters.dateTo !== undefined,
      ),
    ).toBe(true);
    expect(queries.some((query) => /\d+\/\d+/u.test(query.text))).toBe(true);
    expect(
      new Set(queries.map((query) => query.jurisdiction)).size,
    ).toBeGreaterThan(1);
  });

  test("rejects invalid JSON", () => {
    expect(Result.isError(parseGoldenQueryFile("not json"))).toBe(true);
  });

  test("rejects an empty query list", () => {
    expect(Result.isError(parseGoldenQueryFile("[]"))).toBe(true);
  });

  test("rejects duplicate query ids", () => {
    const twice = JSON.stringify([
      { id: "a", jurisdiction: "cze", text: "x" },
      { id: "a", jurisdiction: "svk", text: "y" },
    ]);
    expect(Result.isError(parseGoldenQueryFile(twice))).toBe(true);
  });

  test("rejects unknown keys and malformed fields", () => {
    const unknownKey = JSON.stringify([
      { id: "a", jurisdiction: "cze", text: "x", extra: true },
    ]);
    expect(Result.isError(parseGoldenQueryFile(unknownKey))).toBe(true);

    const badJurisdiction = JSON.stringify([
      { id: "a", jurisdiction: "not-a-code!", text: "x" },
    ]);
    expect(Result.isError(parseGoldenQueryFile(badJurisdiction))).toBe(true);

    const badDate = JSON.stringify([
      {
        id: "a",
        jurisdiction: "cze",
        text: "x",
        filters: { dateFrom: "2015" },
      },
    ]);
    expect(Result.isError(parseGoldenQueryFile(badDate))).toBe(true);
  });
});

describe("rankDocumentHits", () => {
  test("dedupes passages to the document's best rank and counts identityless hits", () => {
    const hits = [
      { document_id: "doc-1" },
      { document_id: "doc-2" },
      { document_id: "doc-1" },
      { other: "field" },
      { document_id: "doc-3" },
    ];
    expect(rankDocumentHits(hits, 20)).toEqual({
      rankedDocumentIds: ["doc-1", "doc-2", "doc-3"],
      unidentifiedHits: 1,
    });
  });

  test("truncates to the requested depth after dedup", () => {
    const hits = [
      { document_id: "doc-1" },
      { document_id: "doc-1" },
      { document_id: "doc-2" },
      { document_id: "doc-3" },
    ];
    expect(rankDocumentHits(hits, 2).rankedDocumentIds).toEqual([
      "doc-1",
      "doc-2",
    ]);
  });
});

describe("diffRankedDocuments", () => {
  test("identical result lists do not diverge", () => {
    const diff = diffRankedDocuments({
      base: outcome(["a", "b", "c"], 30),
      candidate: outcome(["a", "b", "c"], 30),
      depth: 20,
    });
    expect(diff).toEqual({
      overlap: 1,
      divergence: 0,
      hitCountDelta: 0,
      shared: 3,
      entered: 0,
      left: 0,
      meanRankShift: 0,
      maxRankShift: 0,
    });
  });

  test("disjoint result lists diverge fully", () => {
    const diff = diffRankedDocuments({
      base: outcome(["a", "b"]),
      candidate: outcome(["c", "d"]),
      depth: 20,
    });
    expect(diff.divergence).toBe(1);
    expect(diff.shared).toBe(0);
    expect(diff.meanRankShift).toBeNull();
    expect(diff.maxRankShift).toBeNull();
  });

  test("two empty result lists agree rather than diverge", () => {
    const diff = diffRankedDocuments({
      base: outcome([]),
      candidate: outcome([]),
      depth: 20,
    });
    expect(diff.divergence).toBe(0);
  });

  test("an emptied result list diverges fully", () => {
    const diff = diffRankedDocuments({
      base: outcome(["a", "b"], 40),
      candidate: outcome([], 0),
      depth: 20,
    });
    expect(diff.divergence).toBe(1);
    expect(diff.hitCountDelta).toBe(-40);
    expect(diff.left).toBe(2);
  });

  test("rank shifts and membership churn are computed from top-N positions", () => {
    const diff = diffRankedDocuments({
      base: outcome(["a", "b", "c", "d"], 100),
      candidate: outcome(["b", "a", "c", "e"], 90),
      depth: 4,
    });
    // a and b swap (shift 1 each), c holds (shift 0); d left, e entered.
    expect(diff.shared).toBe(3);
    expect(diff.entered).toBe(1);
    expect(diff.left).toBe(1);
    expect(diff.meanRankShift).toBeCloseTo(2 / 3, 2);
    expect(diff.maxRankShift).toBe(1);
    expect(diff.overlap).toBe(3 / 4);
    expect(diff.hitCountDelta).toBe(-10);
  });

  test("only the top-N ranks are compared", () => {
    const diff = diffRankedDocuments({
      base: outcome(["a", "b", "c"]),
      candidate: outcome(["a", "b", "z"]),
      depth: 2,
    });
    expect(diff.divergence).toBe(0);
  });

  const rankedIds = fc.uniqueArray(
    fc.integer({ min: 0, max: 40 }).map((value) => `doc-${value}`),
    { maxLength: 25 },
  );

  test("swapping base and candidate mirrors the diff", () => {
    fc.assert(
      fc.property(
        rankedIds,
        rankedIds,
        fc.nat({ max: 200 }),
        fc.nat({ max: 200 }),
        (baseIds, candidateIds, baseHits, candidateHits) => {
          const forward = diffRankedDocuments({
            base: outcome(baseIds, baseHits),
            candidate: outcome(candidateIds, candidateHits),
            depth: 20,
          });
          const backward = diffRankedDocuments({
            base: outcome(candidateIds, candidateHits),
            candidate: outcome(baseIds, baseHits),
            depth: 20,
          });
          expect(backward.overlap).toBe(forward.overlap);
          expect(backward.divergence).toBe(forward.divergence);
          // Sum form sidesteps the 0 vs -0 distinction Object.is makes.
          expect(backward.hitCountDelta + forward.hitCountDelta).toBe(0);
          expect(backward.shared).toBe(forward.shared);
          expect(backward.entered).toBe(forward.left);
          expect(backward.left).toBe(forward.entered);
          expect(backward.meanRankShift).toBe(forward.meanRankShift);
          expect(backward.maxRankShift).toBe(forward.maxRankShift);
        },
      ),
      propertyConfig(),
    );
  });
});

const row = (id: string, divergence: number): GoldenQueryDiffRow => ({
  query: { id, jurisdiction: "cze", text: id },
  base: outcome(["a"]),
  candidate: outcome(["a"]),
  diff: {
    overlap: 1 - divergence,
    divergence,
    hitCountDelta: 0,
    shared: 1,
    entered: 0,
    left: 0,
    meanRankShift: 0,
    maxRankShift: 0,
  },
});

describe("divergedQueries", () => {
  test("gates strictly above the threshold", () => {
    const rows = [row("at", 0.2), row("above", 0.21), row("below", 0.19)];
    expect(divergedQueries(rows, 0.2).map((entry) => entry.query.id)).toEqual([
      "above",
    ]);
  });
});

describe("renderDiffTable", () => {
  test("renders one line per query and a pass/fail summary", () => {
    const rows = [row("stable", 0), row("shifted", 0.5)];
    const table = renderDiffTable({ rows, depth: 20, maxDivergence: 0.2 });
    const lines = table.split("\n");
    expect(lines.filter((line) => line.startsWith("stable"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("shifted"))).toHaveLength(1);
    expect(table).toContain("DIVERGED");
    expect(table).toContain("1/2 queries within divergence <= 0.2");
    expect(table).toContain("worst 0.50 (shifted)");
  });

  test("reports an empty comparison instead of claiming a pass", () => {
    expect(
      renderDiffTable({ rows: [], depth: 20, maxDivergence: 0.2 }),
    ).toContain("no queries compared");
  });
});
