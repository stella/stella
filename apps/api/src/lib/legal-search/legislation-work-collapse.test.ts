import { panic } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { isAfterSearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import type { SearchCursor } from "@/api/lib/legal-search/corpus-index-pagination";
import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
import {
  collapseLegislationHitsByWork,
  pinnedLegislationWorks,
  shownLegislationVersionId,
} from "@/api/lib/legal-search/legislation-work-collapse";
import type { LegislationWorkRepresentative } from "@/api/lib/legal-search/legislation-work-collapse";
import type { RankedHit } from "@/api/lib/legal-search/rerank";

/** Work A has three versions, `a-current` among them; B has two, none current. */
const WORK_OF = {
  "a-2014": "A",
  "a-2020": "A",
  "a-current": "A",
  "b-2001": "B",
  "b-2005": "B",
  "c-only": "C",
} as const;
const hit = (id: keyof typeof WORK_OF, score: number) => ({
  id,
  score,
  lexicalScore: score,
  citationAuthority: 0,
  work: WORK_OF[id],
});

const REPRESENTATIVES = new Map<string, LegislationWorkRepresentative>([
  ["A", { id: "a-current", isCurrent: true }],
  ["B", { id: "b-2005", isCurrent: false }],
  ["C", { id: "c-only", isCurrent: true }],
  ["N", { id: "n-current", isCurrent: true }],
]);

const collapse = (
  ranked: readonly ReturnType<typeof hit>[],
  options: { namedWorks?: string[]; excludedWork?: string | null } = {},
) =>
  collapseLegislationHitsByWork({
    ranked,
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
  test("every ranked version carries its Work key", () => {
    type CollapseInput = Parameters<typeof collapseLegislationHitsByWork>[0];
    expectTypeOf<RankedHit>().not.toExtend<CollapseInput["ranked"][number]>();
    expectTypeOf<CollapseInput["ranked"][number]>().toExtend<
      RankedHit & { work: string }
    >();
  });

  test("each scanned Work retains its maximum score regardless of version order", () => {
    assertProperty(
      "each scanned Work retains its maximum score regardless of version order",
      fc.property(
        fc.array(fc.record({ work: fc.string(), score: fc.integer() })),
        (versions) => {
          const ranked = versions.map(({ work, score }, index) => ({
            id: String(index),
            work,
            score,
            lexicalScore: score,
            citationAuthority: 0,
          }));
          const options = {
            ranked,
            representatives: new Map(),
            namedWorks: [],
            namedScoreFloor: 10,
            excludedWork: null,
          };
          const collapsed = collapseLegislationHitsByWork(options);
          expect(collapsed.ranked).toHaveLength(
            new Set(versions.map(({ work }) => work)).size,
          );
          for (const shown of collapsed.ranked) {
            const work = collapsed.workOfHit.get(shown.id);
            expect(shown.score).toBe(
              Math.max(
                ...versions
                  .filter((version) => version.work === work)
                  .map(({ score }) => score),
              ),
            );
          }
          const reversed = collapseLegislationHitsByWork({
            ...options,
            ranked: ranked.toReversed(),
          });
          expect(collapsed.ranked).toEqual(reversed.ranked);
          expect(collapsed.workOfHit).toEqual(reversed.workOfHit);
          expect(new Set(collapsed.workTokens)).toEqual(
            new Set(reversed.workTokens),
          );
        },
      ),
    );
  });

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
    const cursor = pageOne.at(-1) ?? panic("page one is empty");

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
      { excludedWork: WORK_OF["a-current"] },
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

  test("a window move carries the cursor Work even when no passage of it survives", () => {
    const { ranked, workTokens } = collapseLegislationHitsByWork({
      ranked: [hit("c-only", 0.7), hit("b-2001", 0.6)],
      representatives: REPRESENTATIVES,
      namedWorks: [],
      namedScoreFloor: 10,
      excludedWork: "A",
    });
    expect(ranked.map(({ id }) => id)).toEqual(["c-only", "b-2001"]);
    expect(new Set(workTokens)).toEqual(
      new Set(["A", "B", "C"].map(corpusSearchGroupToken)),
    );
  });

  test("works an earlier window showed stay off the page, named or not", () => {
    const { ranked, workTokens } = collapseLegislationHitsByWork({
      ranked: [hit("a-2014", 0.9), hit("c-only", 0.7), hit("b-2001", 0.6)],
      representatives: REPRESENTATIVES,
      namedWorks: ["C", "N"],
      namedScoreFloor: 10,
      excludedWork: null,
      excludedWorkTokens: new Set([
        corpusSearchGroupToken("A"),
        corpusSearchGroupToken("N"),
      ]),
    });

    expect(ranked.map(({ id }) => id)).toEqual(["c-only", "b-2001"]);
    // The pin keeps its slot, so C scores as it did before N was shown.
    expect(ranked[0]?.score).toBe(12);
    expect(workTokens.toSorted()).toEqual(
      [corpusSearchGroupToken("B"), corpusSearchGroupToken("C")].toSorted(),
    );
  });
});

describe("the rules both search paths share", () => {
  test("a work is shown as its current version, else as the version it matched", () => {
    expect(
      shownLegislationVersionId("a-2014", { id: "a-current", isCurrent: true }),
    ).toBe("a-current");
    expect(
      shownLegislationVersionId("b-2001", { id: "b-2005", isCurrent: false }),
    ).toBe("b-2001");
    expect(shownLegislationVersionId("x-1", undefined)).toBe("x-1");
  });

  test("named works in force are pinned, else every named work with a version", () => {
    expect(pinnedLegislationWorks(["B", "A", "Z"], REPRESENTATIVES)).toEqual([
      "A",
    ]);
    expect(pinnedLegislationWorks(["B", "Z"], REPRESENTATIVES)).toEqual(["B"]);
  });

  test("a token is fixed-width and differs between works", () => {
    expect(corpusSearchGroupToken("A")).toMatch(/^[A-Za-z0-9_-]{6}$/u);
    expect(corpusSearchGroupToken("A")).not.toBe(corpusSearchGroupToken("B"));
  });
});
