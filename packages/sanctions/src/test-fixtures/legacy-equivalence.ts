import { panic } from "better-result";
import { expect } from "bun:test";

import type { ParsedList, SanctionsEntry } from "../entry";
import { buildScreeningIndex, screen, type ScreeningQuery } from "../screening";
import { compactLists } from "./compact-lists";
import type { screen as legacyScreen } from "./legacy-screening";

type SeededEntryOptions = {
  base: SanctionsEntry;
  sourceId: string;
  names: SanctionsEntry["names"];
};

const seededEntry = ({
  base,
  sourceId,
  names,
}: SeededEntryOptions): SanctionsEntry => ({
  ...base,
  sourceId,
  names,
  entityType: "person",
});

export const equivalenceLists = (counts = [20_000, 420, 380]): ParsedList[] => {
  const lists = compactLists(counts);
  const ofac = lists.at(0);
  const base = ofac?.entries.at(0);
  if (ofac === undefined || base === undefined) {
    panic("compact list fixture has no OFAC entry");
  }
  ofac.entries.push(
    seededEntry({
      base,
      sourceId: "transliterations",
      names: [
        { name: "Zerovan Velnakov", quality: "strong" },
        { name: "Velnakov, Zerovan", quality: "strong" },
        { name: "Зерован Велнаков", quality: "strong" },
        { name: "Zerowan Welnakow", quality: "weak" },
      ],
    }),
    seededEntry({
      base,
      sourceId: "joined-name",
      names: [
        { name: "Nelori VELNO-RAK", quality: "strong" },
        { name: "Talunor Velmoraki", quality: "strong" },
      ],
    }),
    seededEntry({
      base,
      sourceId: "duplicate-alias-quality",
      names: [
        { name: "Kelori Al-Velnar", quality: "weak" },
        { name: "Kelori Al-Velnar", quality: "strong" },
        { name: "Kelori Velnar", quality: "weak" },
      ],
    }),
  );
  return lists;
};

export const successfulQueries = (
  lists: readonly ParsedList[],
): ScreeningQuery[] => {
  const queries: ScreeningQuery[] = [];
  for (const list of lists) {
    for (const entry of list.entries.slice(0, 3)) {
      const primary = entry.names.at(0);
      const alias = entry.names.at(-1);
      if (primary === undefined || alias === undefined) {
        panic("compact list fixture has a nameless entry");
      }
      queries.push(
        { name: primary.name, entityType: entry.entityType },
        { name: alias.name, entityType: entry.entityType },
      );
    }
  }
  queries.push(
    { name: "Zerovan Velnakov", entityType: "person" },
    { name: "Velnakov, Zerovan", entityType: "person" },
    { name: "Зерован Велнаков", entityType: "person" },
    { name: "Zerowan Welnakow", entityType: "person" },
    { name: "Nelori Velnorak", entityType: "person" },
    { name: "Talunor Vel Moraki", entityType: "person" },
    { name: "Kelori Al-Velnar", entityType: "person" },
    { name: "Kelori Velnar", entityType: "person" },
    { name: "unlisted unfamiliar name", entityType: "person" },
    { name: "Zerovn Velnakov", entityType: "person" },
  );
  return queries;
};

export const legacyScreenOutcome = (result: ReturnType<typeof legacyScreen>) =>
  result.isErr() ? { error: result.error } : { value: result.value };

// The fuzzy-search engine defines complete-result ordering; the independent
// legacy score oracle is covered separately on the small edition fixture.
export const screeningOutcomes = (
  lists: readonly ParsedList[],
  queries: readonly ScreeningQuery[],
) => {
  const baseline = buildScreeningIndex(lists);
  return queries.map((query) =>
    legacyScreenOutcome(screen(baseline, query, { cutoff: 0.65, limit: 25 })),
  );
};

type ScreeningEquivalenceOptions = {
  index: ReturnType<typeof buildScreeningIndex>;
  expected: readonly ReturnType<typeof legacyScreenOutcome>[];
  queries: readonly ScreeningQuery[];
};

export const assertScreeningEquivalence = ({
  index,
  expected,
  queries,
}: ScreeningEquivalenceOptions) => {
  for (const [queryIndex, query] of queries.entries()) {
    const legacyResult =
      expected.at(queryIndex) ?? panic("Missing legacy screening result");
    expect(
      legacyScreenOutcome(screen(index, query, { cutoff: 0.65, limit: 25 })),
    ).toEqual(legacyResult);
  }
};

type AliasHitOptions = {
  index: ReturnType<typeof buildScreeningIndex>;
  name: string;
  expectedName: string;
  sourceId?: string;
};

export const expectAliasHit = ({
  index,
  name,
  expectedName,
  sourceId = "transliterations",
}: AliasHitOptions) => {
  const matches = screen(
    index,
    { name, entityType: "person" },
    { cutoff: 0.65 },
  ).unwrap("Alias fixture screening must succeed").possibleMatches;
  expect(matches.map(({ entry }) => entry.sourceId)).toContain(sourceId);
  expect(
    matches.find(({ entry }) => entry.sourceId === sourceId)?.evidence
      .matchedName,
  ).toBe(expectedName);
};
