import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { isAfterSearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import { collapseLegislationHitsByWork } from "@/api/lib/legal-search/legislation-work-collapse";
import type { LegislationWorkRepresentative } from "@/api/lib/legal-search/legislation-work-collapse";
import type { RankedHit } from "@/api/lib/legal-search/rerank";

const hit = (id: string, score: number): RankedHit => ({
  id,
  score,
  lexicalScore: score,
  citationAuthority: 0,
});

/** Work A has three versions, `a-current` among them; B has two, none current. */
const WORK_OF = new Map([
  ["a-2014", "A"],
  ["a-2020", "A"],
  ["a-current", "A"],
  ["b-2001", "B"],
  ["b-2005", "B"],
  ["c-only", "C"],
]);
const REPRESENTATIVES = new Map<string, LegislationWorkRepresentative>([
  ["A", { id: "a-current", isCurrent: true }],
  ["B", { id: "b-2005", isCurrent: false }],
  ["C", { id: "c-only", isCurrent: true }],
  ["N", { id: "n-current", isCurrent: true }],
]);

const collapse = (
  ranked: readonly RankedHit[],
  options: { namedWorks?: string[]; excludedWork?: string | null } = {},
) =>
  collapseLegislationHitsByWork({
    ranked,
    workOf: WORK_OF,
    representatives: REPRESENTATIVES,
    namedWorks: options.namedWorks ?? [],
    namedScoreFloor: 10,
    excludedWork: options.excludedWork ?? null,
  }).ranked;

/** The relevance cursor a page ending at `last` hands the next request. */
const boundaryOf = (last: { score: number; id: string }): SearchCursor => ({
  score: last.score,
  id: last.id,
  sort: "relevance",
  windowStart: 0,
});

describe("collapseLegislationHitsByWork", () => {
  test("several versions of one work become one hit, shown as the current version", () => {
    const ranked = collapse([
      hit("a-2014", 0.9),
      hit("a-2020", 0.8),
      hit("c-only", 0.7),
      hit("a-current", 0.2),
    ]);

    expect(ranked.map(({ id, score }) => ({ id, score }))).toEqual([
      { id: "a-current", score: 0.9 },
      { id: "c-only", score: 0.7 },
    ]);
  });

  test("a work with no current version is shown as its best-scoring version", () => {
    const ranked = collapse([hit("b-2001", 0.6), hit("b-2005", 0.5)]);

    expect(ranked.map(({ id }) => id)).toEqual(["b-2001"]);
  });

  test("a named work comes first, even when the scan did not reach it", () => {
    const ranked = collapse([hit("a-2014", 0.9), hit("c-only", 0.7)], {
      namedWorks: ["C", "N"],
    });

    expect(ranked.map(({ id }) => id)).toEqual([
      "c-only",
      "n-current",
      "a-current",
    ]);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? Infinity);
    expect(ranked[1]?.score).toBeGreaterThan(ranked[2]?.score ?? Infinity);
  });

  test("a work already shown does not reappear on the next page", () => {
    // Page one of a scan that reached two versions of A and one of C.
    const firstScan = collapse([
      hit("a-2014", 0.9),
      hit("c-only", 0.7),
      hit("a-2020", 0.4),
    ]);
    const pageOne = firstScan.slice(0, 1);
    const cursor = pageOne.at(-1);
    if (cursor === undefined) {
      return panic("page one is empty");
    }

    // Page two replays the window further; the scan skips the cursor's own
    // document and finds more of A, which must not come back.
    const secondScan = collapse(
      [
        hit("a-2014", 0.9),
        hit("c-only", 0.7),
        hit("a-2020", 0.4),
        hit("b-2001", 0.3),
        hit("a-current", 0.1),
      ].filter(({ id }) => id !== cursor.id),
      { excludedWork: WORK_OF.get("a-current") ?? null },
    );
    const pageTwo = secondScan.filter((candidate) =>
      isAfterSearchCursor(candidate, boundaryOf(cursor)),
    );

    expect(pageOne.map(({ id }) => id)).toEqual(["a-current"]);
    expect(pageTwo.map(({ id }) => id)).toEqual(["c-only", "b-2001"]);
  });

  test("the same scan ranks the same way twice", () => {
    const ranked = [hit("b-2005", 0.5), hit("a-2020", 0.5), hit("c-only", 0.5)];

    expect(collapse(ranked)).toEqual(collapse(ranked.toReversed()));
  });
});
