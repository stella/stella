import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { collapseByLanguageGroup } from "@/api/lib/legal-search/language-group-collapse";

type Candidate = { id: string; score: number };

const groupOf = (groups: ReadonlyMap<string, string | null>) => (id: string) =>
  groups.get(id) ?? null;

/**
 * Candidates in best-first order, each optionally assigned to one of a few
 * language groups. Ids are unique, as the pagination layer guarantees.
 */
const collapseInput = fc
  .uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), {
    minLength: 0,
    maxLength: 40,
  })
  .chain((ids) =>
    fc
      .array(fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }), {
        minLength: ids.length,
        maxLength: ids.length,
      })
      .map((groupIndexes) => ({
        candidates: ids.map((id, index) => ({
          id,
          score: 1 - index / Math.max(1, ids.length),
        })),
        groups: new Map(
          ids.map((id, index) => {
            const groupIndex = groupIndexes[index] ?? null;
            return [id, groupIndex === null ? null : `group-${groupIndex}`];
          }),
        ),
      })),
  );

describe("collapsing candidates by language group", () => {
  test("every group is represented exactly once, by its first candidate", () => {
    fc.assert(
      fc.property(collapseInput, ({ candidates, groups }) => {
        const { representatives } = collapseByLanguageGroup(
          candidates,
          groupOf(groups),
        );

        const seenGroups = new Set<string>();
        for (const representative of representatives) {
          const group = groups.get(representative.id) ?? null;
          if (group === null) {
            continue;
          }
          expect(seenGroups.has(group)).toBe(false);
          seenGroups.add(group);
          const firstOfGroup = candidates.find(
            (candidate) => groups.get(candidate.id) === group,
          );
          expect(firstOfGroup?.id).toBe(representative.id);
        }
        const inputGroups = new Set(
          candidates
            .map((candidate) => groups.get(candidate.id) ?? null)
            .filter((group): group is string => group !== null),
        );
        expect(seenGroups).toEqual(inputGroups);
      }),
      propertyConfig(),
    );
  });

  test("ungrouped candidates and representatives keep their order and scores", () => {
    fc.assert(
      fc.property(collapseInput, ({ candidates, groups }) => {
        const { representatives } = collapseByLanguageGroup(
          candidates,
          groupOf(groups),
        );
        const representativeIds = new Set(
          representatives.map((candidate) => candidate.id),
        );

        expect(representatives).toEqual(
          candidates.filter((candidate) => representativeIds.has(candidate.id)),
        );
        for (const candidate of candidates) {
          if ((groups.get(candidate.id) ?? null) === null) {
            expect(representativeIds.has(candidate.id)).toBe(true);
          }
        }
      }),
      propertyConfig(),
    );
  });

  test("folded candidates partition the input against the representatives", () => {
    fc.assert(
      fc.property(collapseInput, ({ candidates, groups }) => {
        const { foldedInto, representatives } = collapseByLanguageGroup(
          candidates,
          groupOf(groups),
        );

        expect(foldedInto.size + representatives.length).toBe(
          candidates.length,
        );
        for (const [foldedId, representativeId] of foldedInto) {
          expect(groups.get(foldedId)).toBe(groups.get(representativeId));
          expect(
            representatives.some(
              (candidate) => candidate.id === representativeId,
            ),
          ).toBe(true);
        }
      }),
      propertyConfig(),
    );
  });

  test("a judgment matched in several languages is one hit ranked by its best version", () => {
    const candidates: Candidate[] = [
      { id: "c-131-12-fr", score: 0.9 },
      { id: "other", score: 0.8 },
      { id: "c-131-12-en", score: 0.7 },
      { id: "c-131-12-cs", score: 0.6 },
    ];
    const groups = new Map<string, string | null>([
      ["c-131-12-fr", "ECLI:EU:C:2014:317"],
      ["other", null],
      ["c-131-12-en", "ECLI:EU:C:2014:317"],
      ["c-131-12-cs", "ECLI:EU:C:2014:317"],
    ]);

    const { foldedInto, representatives } = collapseByLanguageGroup(
      candidates,
      groupOf(groups),
    );

    expect(representatives.map((candidate) => candidate.id)).toEqual([
      "c-131-12-fr",
      "other",
    ]);
    expect(foldedInto.get("c-131-12-en")).toBe("c-131-12-fr");
    expect(foldedInto.get("c-131-12-cs")).toBe("c-131-12-fr");
  });
});
