import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  classifyCorpusRehydration,
  eligibleCorpusRows,
} from "@/api/lib/legal-search/corpus-rehydration-disposition";
import {
  setLogSinkForTesting,
  type LogRecord,
} from "@/api/lib/observability/logger";

test("canonical rehydration has one disposition for every row state", () => {
  expect(classifyCorpusRehydration(undefined)).toEqual({
    type: "drift",
    reason: "canonical_row_unresolved",
  });
  expect(classifyCorpusRehydration({ eligible: false })).toEqual({
    type: "excluded",
    reason: "eligibility_rule",
  });
  expect(classifyCorpusRehydration({ eligible: true })).toEqual({
    type: "eligible",
  });
});

test("canonical disposition accounting preserves eligible rows and counts unique candidates", () => {
  const records: LogRecord[] = [];
  setLogSinkForTesting((record) => {
    records.push(record);
  });
  try {
    assertProperty(
      "canonical disposition accounting preserves eligible rows and counts unique candidates",
      fc.property(
        fc.array(fc.constantFrom("eligible", "excluded", "drift"), {
          maxLength: 40,
        }),
        (states) => {
          records.length = 0;
          const ids = states.map((_, index) => String(index));
          const rows = states.flatMap((state, index) =>
            state === "drift"
              ? []
              : [
                  {
                    id: String(index),
                    eligible: state === "eligible",
                    score: index,
                  },
                ],
          );
          const output = eligibleCorpusRows({
            family: "case_law",
            ids: [...ids, ...ids],
            rows,
          });
          expect(output).toEqual(rows.filter((row) => row.eligible));
          for (const row of output) {
            expect(rows.includes(row)).toBe(true);
          }
          const excluded = states.filter(
            (state) => state === "excluded",
          ).length;
          const drift = states.filter((state) => state === "drift").length;
          if (excluded + drift === 0) {
            expect(records).toEqual([]);
            return;
          }
          expect(records).toHaveLength(1);
          expect(records.at(0)?.attributes).toEqual({
            family: "case_law",
            stage: "rehydration",
            malformed: 0,
            excluded,
            drift,
          });
        },
      ),
    );
  } finally {
    setLogSinkForTesting(null);
  }
});
