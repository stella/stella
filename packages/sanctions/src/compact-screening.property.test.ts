import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  buildScreeningIndex,
  buildScreeningIndexCooperatively,
} from "./screening";
import type { ScreeningQuery } from "./screening";
import {
  assertScreeningEquivalence,
  equivalenceLists,
  expectAliasHit,
  screeningOutcomes,
  successfulQueries,
} from "./test-fixtures/legacy-equivalence";

const yieldImmediately = async () => {
  await Promise.resolve();
};

test("full-scale compact and cooperative screening preserve complete screening results", async () => {
  const lists = equivalenceLists();
  const queries = successfulQueries(lists);
  const expected = screeningOutcomes(lists, queries);
  const compact = buildScreeningIndex(lists);
  let entryIndex = 0;
  for (const list of lists) {
    for (const entry of list.entries) {
      expect(compact.entryStorage.hydrate(entryIndex)).toEqual(entry);
      entryIndex += 1;
    }
  }
  expect(compact.entries.length).toBe(entryIndex);
  assertScreeningEquivalence({ index: compact, expected, queries });
  expectAliasHit({
    index: compact,
    name: "Zerovan Velnakov",
    expectedName: "Zerovan Velnakov",
  });
  expectAliasHit({
    index: compact,
    name: "Zerowan Welnakow",
    expectedName: "Zerovan Velnakov",
  });
  expectAliasHit({
    index: compact,
    name: "Nelori Velnorak",
    expectedName: "Nelori VELNO-RAK",
    sourceId: "joined-name",
  });
  expectAliasHit({
    index: compact,
    name: "Kelori Al-Velnar",
    expectedName: "Kelori Al-Velnar",
    sourceId: "duplicate-alias-quality",
  });

  Bun.gc(true);
  const cooperative = await buildScreeningIndexCooperatively(
    lists,
    yieldImmediately,
  );
  assertScreeningEquivalence({ index: cooperative, expected, queries });
}, 120_000);

test("small random lists and queries preserve complete screening results", async () => {
  await assertProperty(
    "small random lists and queries preserve complete screening results",
    fc.asyncProperty(
      fc.tuple(
        fc.array(fc.integer({ min: 1, max: 12 }), {
          minLength: 3,
          maxLength: 3,
        }),
        fc.array(fc.string({ minLength: 1, maxLength: 24 }), {
          maxLength: 5,
        }),
      ),
      async ([counts, randomNames]) => {
        const lists = equivalenceLists(counts);
        const queries: ScreeningQuery[] = [
          ...successfulQueries(lists),
          ...randomNames.map((name) => ({ name })),
        ];
        const expected = screeningOutcomes(lists, queries);
        assertScreeningEquivalence({
          index: buildScreeningIndex(lists),
          expected,
          queries,
        });
        const cooperative = await buildScreeningIndexCooperatively(
          lists,
          yieldImmediately,
        );
        assertScreeningEquivalence({ index: cooperative, expected, queries });
      },
    ),
    { numRuns: 20 },
  );
});
