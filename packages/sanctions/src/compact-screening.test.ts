import { expect, test } from "bun:test";

import type { ParsedList, SanctionsEntry } from "./entry";
import {
  buildScreeningIndex,
  buildScreeningIndexCooperatively,
  screen,
} from "./screening";
import type { ScreeningQuery } from "./screening";
import { compactLists } from "./test-fixtures/compact-lists";
import {
  buildScreeningIndex as buildLegacyScreeningIndex,
  screen as legacyScreen,
} from "./test-fixtures/legacy-screening";

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

const equivalenceLists = (counts = [20_000, 420, 380]): ParsedList[] => {
  const lists = compactLists(counts);
  const ofac = lists.at(0);
  const base = ofac?.entries.at(0);
  if (ofac === undefined || base === undefined) {
    throw new Error("compact list fixture has no OFAC entry");
  }
  ofac.entries.push(
    seededEntry({
      base,
      sourceId: "transliterations",
      names: [
        { name: "Vladimir Putin", quality: "strong" },
        { name: "Putin, Vladimir", quality: "strong" },
        { name: "Владимир Путин", quality: "strong" },
        { name: "Wladimir Putin", quality: "weak" },
      ],
    }),
    seededEntry({
      base,
      sourceId: "joined-name",
      names: [
        { name: "Aziz HAJMOHAM-MADI", quality: "strong" },
        { name: "Noorollah Azizmohammadi", quality: "strong" },
      ],
    }),
    seededEntry({
      base,
      sourceId: "duplicate-alias-quality",
      names: [
        { name: "Khalid Al-Mansur", quality: "weak" },
        { name: "Khalid Al-Mansur", quality: "strong" },
        { name: "Khalid Mansur", quality: "weak" },
      ],
    }),
  );
  return lists;
};

const successfulQueries = (lists: readonly ParsedList[]): ScreeningQuery[] => {
  const queries: ScreeningQuery[] = [];
  for (const list of lists) {
    for (const entry of list.entries.slice(0, 3)) {
      const primary = entry.names.at(0);
      const alias = entry.names.at(-1);
      if (primary === undefined || alias === undefined) {
        throw new Error("compact list fixture has a nameless entry");
      }
      queries.push(
        { name: primary.name, entityType: entry.entityType },
        { name: alias.name, entityType: entry.entityType },
      );
    }
  }
  queries.push(
    { name: "Vladimir Putin", entityType: "person" },
    { name: "Putin, Vladimir", entityType: "person" },
    { name: "Владимир Путин", entityType: "person" },
    { name: "Wladimir Putin", entityType: "person" },
    { name: "Aziz Hajmohammadi", entityType: "person" },
    { name: "Noorollah Aziz Mohammadi", entityType: "person" },
    { name: "Khalid Al-Mansur", entityType: "person" },
    { name: "Khalid Mansur", entityType: "person" },
    { name: "unlisted unfamiliar name", entityType: "person" },
    { name: "Vladmir Putin", entityType: "person" },
  );
  return queries;
};

type LegacyEquivalenceOptions = {
  index: ReturnType<typeof buildScreeningIndex>;
  lists: readonly ParsedList[];
  queries: readonly ScreeningQuery[];
};

const assertLegacyEquivalence = ({
  index,
  lists,
  queries,
}: LegacyEquivalenceOptions) => {
  const legacy = buildLegacyScreeningIndex(lists);
  for (const query of queries) {
    const options = { cutoff: 0.65, limit: 25 };
    const expected = legacyScreen(legacy, query, options);
    const actual = screen(index, query, options);
    expect(actual.isErr() ? actual.error : actual.value).toEqual(
      expected.isErr() ? expected.error : expected.value,
    );
  }
};

type AliasHitOptions = {
  index: ReturnType<typeof buildScreeningIndex>;
  name: string;
  expectedName: string;
  sourceId?: string;
};

const expectAliasHit = ({
  index,
  name,
  expectedName,
  sourceId = "transliterations",
}: AliasHitOptions) => {
  const matches = screen(
    index,
    { name, entityType: "person" },
    { cutoff: 0.65 },
  ).unwrap().possibleMatches;
  expect(matches.map(({ entry }) => entry.sourceId)).toContain(sourceId);
  expect(
    matches.find(({ entry }) => entry.sourceId === sourceId)?.evidence
      .matchedName,
  ).toBe(expectedName);
};

test("compact and cooperative screening preserve legacy results and full entries", async () => {
  const lists = equivalenceLists();
  const queries = successfulQueries(lists);
  {
    const current = buildScreeningIndex(lists);
    let entryIndex = 0;
    for (const list of lists) {
      for (const entry of list.entries) {
        expect(current.entryStorage.hydrate(entryIndex)).toEqual(entry);
        entryIndex += 1;
      }
    }
    expect(current.entries.length).toBe(entryIndex);
    assertLegacyEquivalence({ index: current, lists, queries });
    expectAliasHit({
      index: current,
      name: "Vladimir Putin",
      expectedName: "Vladimir Putin",
    });
    expectAliasHit({
      index: current,
      name: "Wladimir Putin",
      expectedName: "Vladimir Putin",
    });
    expectAliasHit({
      index: current,
      name: "Aziz Hajmohammadi",
      expectedName: "Aziz HAJMOHAM-MADI",
      sourceId: "joined-name",
    });
    expectAliasHit({
      index: current,
      name: "Khalid Al-Mansur",
      expectedName: "Khalid Al-Mansur",
      sourceId: "duplicate-alias-quality",
    });
  }
  Bun.gc(true);
  const cooperative = await buildScreeningIndexCooperatively(
    lists,
    async () => {},
  );
  expect(cooperative.entries.length).toBe(
    lists.reduce((count, list) => count + list.entries.length, 0),
  );
  assertLegacyEquivalence({ index: cooperative, lists, queries });
});

test("compact screening preserves legacy work-limit and query errors", () => {
  Bun.gc(true);
  const lists = equivalenceLists([20, 10, 10]);
  const current = buildScreeningIndex(lists);
  const legacy = buildLegacyScreeningIndex(lists);
  const cases = [
    {
      query: { name: "Vladimir Putin", entityType: "person" },
      options: { cutoff: 0.65, maxWork: 1 },
    },
    {
      query: { name: "Vladimir Putin", birthDate: { year: 999 } },
      options: { cutoff: 0.65 },
    },
    { query: { name: " — " }, options: { cutoff: 0.65 } },
  ] as const satisfies readonly {
    query: ScreeningQuery;
    options: { cutoff: number; maxWork?: number };
  }[];

  for (const { query, options } of cases) {
    const expected = legacyScreen(legacy, query, options);
    const actual = screen(current, query, options);
    expect(actual.isErr() ? actual.error : actual.value).toEqual(
      expected.isErr() ? expected.error : expected.value,
    );
  }
});
