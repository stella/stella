import { expect, test } from "bun:test";

import {
  buildScreeningIndex,
  buildScreeningIndexCooperatively,
  screen,
} from "./screening";
import type { ScreeningQuery } from "./screening";
import { compactLists } from "./test-fixtures/compact-lists";
import {
  assertScreeningEquivalence,
  equivalenceLists,
  expectAliasHit,
  legacyScreenOutcome,
  screeningOutcomes,
  successfulQueries,
} from "./test-fixtures/legacy-equivalence";
import {
  buildScreeningIndex as buildLegacyScreeningIndex,
  screen as legacyScreen,
} from "./test-fixtures/legacy-screening";

test("compact and cooperative screening preserve complete results and full entries", async () => {
  const lists = equivalenceLists([3, 3, 3]);
  const queries = successfulQueries(lists);
  const expected = screeningOutcomes(lists, queries);

  Bun.gc(true);
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
    assertScreeningEquivalence({ index: current, expected, queries });
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
  assertScreeningEquivalence({ index: cooperative, expected, queries });
});

test("compact screening preserves independent legacy scores on small editions", () => {
  const lists = equivalenceLists([3, 2, 2]);
  const queries = successfulQueries(lists);
  const legacy = buildLegacyScreeningIndex(lists);
  assertScreeningEquivalence({
    index: buildScreeningIndex(lists),
    queries,
    expected: queries.map((query) =>
      legacyScreenOutcome(
        legacyScreen(legacy, query, { cutoff: 0.65, limit: 25 }),
      ),
    ),
  });
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

test("repeated absent spellings replay fresh results across the work-budget boundary", () => {
  const lists = equivalenceLists([20, 10, 10]);
  const compact = buildScreeningIndex(lists);
  const legacy = buildLegacyScreeningIndex(lists);
  const query = { name: "Kelori Velnr", entityType: "person" } as const;
  expect(compact.names.raw.ids.get("velnr")).toBeUndefined();
  let completeWork = 0;
  const complete = screen(compact, query, {
    cutoff: 0.65,
    onWork: ({ spent }) => {
      completeWork = spent;
    },
  }).unwrap();
  expect(completeWork).toBeGreaterThan(1);
  expect(complete).toEqual(
    legacyScreen(legacy, query, { cutoff: 0.65 }).unwrap(),
  );
  // Work accounting belongs to the entity index: the complete lookup reports
  // its own spend, so budgets spread around it place the boundary without a
  // search. Repeated and fresh lookups must agree at every budget, and the
  // outcome must switch from failure to success exactly once.
  const budgets = [
    1,
    Math.floor(completeWork / 3),
    Math.floor((completeWork * 2) / 3),
    completeWork - 1,
    completeWork,
    completeWork + 1,
    completeWork * 2,
    completeWork * 4,
  ]
    .filter((maxWork) => maxWork >= 1)
    .filter((maxWork, index, values) => values.indexOf(maxWork) === index)
    .toSorted((left, right) => left - right);
  const outcomes: ("failure" | "success")[] = [];
  for (const maxWork of budgets) {
    const options = { cutoff: 0.65, maxWork };
    const expected = screen(buildScreeningIndex(lists), query, options);
    const actual = screen(compact, query, options);
    expect(legacyScreenOutcome(actual)).toEqual(legacyScreenOutcome(expected));
    if (expected.isErr()) {
      expect(expected.error.code).toBe("work-limit");
      outcomes.push("failure");
    } else {
      expect(expected.value).toEqual(complete);
      outcomes.push("success");
    }
  }
  expect(outcomes.at(0)).toBe("failure");
  expect(outcomes.at(-1)).toBe("success");
  expect(
    outcomes.filter((outcome, index) => outcome !== outcomes.at(index - 1)),
  ).toEqual(["failure", "success"]);
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
