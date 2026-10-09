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
      name: "Zerovan Velnakov",
      expectedName: "Zerovan Velnakov",
    });
    expectAliasHit({
      index: current,
      name: "Zerowan Welnakow",
      expectedName: "Zerovan Velnakov",
    });
    expectAliasHit({
      index: current,
      name: "Nelori Velnorak",
      expectedName: "Nelori VELNO-RAK",
      sourceId: "joined-name",
    });
    expectAliasHit({
      index: current,
      name: "Kelori Al-Velnar",
      expectedName: "Kelori Al-Velnar",
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
      query: { name: "Zerovan Velnakov", entityType: "person" },
      options: { cutoff: 0.65, maxWork: 1 },
    },
    {
      query: { name: "Zerovan Velnakov", birthDate: { year: 999 } },
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

test("identifier-only screening preserves shared postings and legacy work limits", () => {
  const lists = compactLists([2, 0, 0]);
  const list = lists.at(0);
  const first = list?.entries.at(0);
  const second = list?.entries.at(1);
  if (list === undefined || first === undefined || second === undefined) {
    throw new Error("identifier fixture needs two entries");
  }
  const identifier = first.identifiers.at(0);
  if (identifier === undefined) {
    throw new Error("identifier fixture needs a passport");
  }
  first.identifiers = [
    { ...identifier, number: "SX-314 159" },
    { ...identifier, number: "sx314159" },
    { ...identifier, number: "SX 314-159" },
  ];
  second.identifiers = [{ ...identifier, number: "SX314159" }];
  const current = buildScreeningIndex(lists);
  const legacy = buildLegacyScreeningIndex(lists);
  const queries = [
    { name: "", identifiers: ["sx 314-159"] },
    { name: "", identifiers: ["SX314159", "SX-314 159"] },
  ] as const satisfies readonly ScreeningQuery[];
  for (const query of queries) {
    const expected = legacyScreen(legacy, query, { cutoff: 0.8 }).unwrap();
    expect(expected.possibleMatches.map(({ entry }) => entry.sourceId)).toEqual(
      [first.sourceId, second.sourceId],
    );
    expect(
      expected.possibleMatches.every(
        ({ evidence }) =>
          evidence.identifier === "match" &&
          evidence.matchedName === null &&
          evidence.nameScore === 0,
      ),
    ).toBe(true);
    expect(screen(current, query, { cutoff: 0.8 }).unwrap()).toEqual(expected);
    let failures = 0;
    let successes = 0;
    // Sweep both sides of the success threshold: duplicate postings preserve
    // result values after Set deduplication but incorrectly consume more work.
    for (let maxWork = 1; maxWork <= 64; maxWork += 1) {
      const options = { cutoff: 0.8, maxWork };
      const expectedBudget = legacyScreen(legacy, query, options);
      const actualBudget = screen(current, query, options);
      expect(actualBudget.isErr()).toBe(expectedBudget.isErr());
      expect(
        actualBudget.isErr() ? actualBudget.error : actualBudget.value,
      ).toEqual(
        expectedBudget.isErr() ? expectedBudget.error : expectedBudget.value,
      );
      if (expectedBudget.isErr()) {
        expect(expectedBudget.error.code).toBe("work-limit");
        failures += 1;
      } else {
        successes += 1;
      }
    }
    expect(failures).toBeGreaterThan(0);
    expect(successes).toBeGreaterThan(0);
  }
});
