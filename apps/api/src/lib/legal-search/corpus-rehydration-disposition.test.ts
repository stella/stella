import { afterEach, beforeEach, expect, test } from "bun:test";
import fc from "fast-check";

import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";

import { createCorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";
import {
  partitionCorpusRehydration,
  recordCorpusRehydrationDispositions,
} from "@/api/lib/legal-search/corpus-rehydration-disposition";
import {
  installRecordingLogger,
  type RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

let logs: RecordingLogger;
beforeEach(() => {
  logs = installRecordingLogger();
});
afterEach(() => {
  logs.restore();
});

test("canonical rehydration separates eligible content from id-only dispositions", () => {
  const row = { id: "eligible", text: "displayable content" };
  const partition = partitionCorpusRehydration({
    ids: ["eligible", "excluded", "missing", "missing"],
    records: [
      { id: "eligible", row },
      { id: "excluded", row: null },
    ],
  });
  expect(partition).toEqual({
    rows: [row],
    dispositions: [
      { id: "excluded", type: "excluded" },
      { id: "missing", type: "drift" },
    ],
  });
  expect(partition.rows.at(0)).toBe(row);
  const counter = createCorpusHitDispositionCounter();
  recordCorpusRehydrationDispositions(partition.dispositions, counter);
  expect(counter.snapshot()).toEqual({ malformed: 0, excluded: 1, drift: 1 });
  expect(logs.records).toEqual([]);
});

const REHYDRATION_STATES = ["eligible", "excluded", "drift"] as const;

test("canonical disposition accounting preserves eligible rows and counts unique candidates", () => {
  assertProperty(
    "canonical disposition accounting preserves eligible rows and counts unique candidates",
    fc.property(
      fc.array(fc.constantFrom(...REHYDRATION_STATES), { maxLength: 40 }),
      (states) => {
        const fixtures = states.map((state, index) => ({
          state,
          id: String(index),
          row: {
            id: String(index),
            score: index,
            text: `displayable-content-${index}`,
          },
        }));
        const ids = fixtures.map(({ id }) => id);
        const records = fixtures.flatMap(({ state, id, row }) =>
          state === "drift"
            ? []
            : [{ id, row: state === "eligible" ? row : null }],
        );
        const expectedRows = fixtures
          .filter(({ state }) => state === "eligible")
          .map(({ row }) => row);
        const expectedDispositions = fixtures.flatMap(({ state, id }) =>
          state === "eligible" ? [] : [{ id, type: state }],
        );
        const output = partitionCorpusRehydration({
          ids: [...ids, ...ids],
          records,
        });

        expect(Object.keys(output).toSorted()).toEqual([
          "dispositions",
          "rows",
        ]);
        expect(output.rows).toEqual(expectedRows);
        for (const [index, expectedRow] of expectedRows.entries()) {
          expect(output.rows.at(index)).toBe(expectedRow);
        }
        expect(
          output.dispositions.toSorted((left, right) =>
            compareCodeUnit(left.id, right.id),
          ),
        ).toEqual(
          expectedDispositions.toSorted((left, right) =>
            compareCodeUnit(left.id, right.id),
          ),
        );
        for (const disposition of output.dispositions) {
          expect(Object.keys(disposition).toSorted()).toEqual(["id", "type"]);
        }
        expect(JSON.stringify(output.dispositions)).not.toContain(
          "displayable-content",
        );

        const counter = createCorpusHitDispositionCounter();
        counter.record({ malformed: 2 });
        // Each prefix models a scan retaining candidates from earlier rounds.
        for (let length = 0; length <= fixtures.length; length += 1) {
          const roundIds = ids.slice(0, length);
          const round = partitionCorpusRehydration({
            ids: roundIds,
            records: records.filter(({ id }) => roundIds.includes(id)),
          });
          recordCorpusRehydrationDispositions(round.dispositions, counter);
          expect(counter.snapshot()).toEqual({
            malformed: 2,
            excluded: states
              .slice(0, length)
              .filter((state) => state === "excluded").length,
            drift: states.slice(0, length).filter((state) => state === "drift")
              .length,
          });
        }
        recordCorpusRehydrationDispositions(output.dispositions, counter);
        expect(counter.snapshot()).toEqual({
          malformed: 2,
          excluded: states.filter((state) => state === "excluded").length,
          drift: states.filter((state) => state === "drift").length,
        });
        expect(logs.records).toEqual([]);
      },
    ),
  );
});
