import { describe, expect, test } from "bun:test";

import {
  aggregateSanctionsScreeningStatus,
  SANCTIONS_SCREENING_STATUSES,
  type SanctionsScreeningStatus,
} from "./screening-vocabulary";

// Every sequence of list statuses up to this length: the status domain is
// small enough to cover each combination and order instead of sampling.
const MAX_LISTS = 5;

const sequences = (length: number): SanctionsScreeningStatus[][] =>
  length === 0
    ? [[]]
    : sequences(length - 1).flatMap((prefix) =>
        SANCTIONS_SCREENING_STATUSES.map((status) => [...prefix, status]),
      );

const ALL_SEQUENCES = Array.from({ length: MAX_LISTS + 1 }, (_, length) =>
  sequences(length),
).flat();

describe("the screening status of a set of lists", () => {
  test("covers every combination of list statuses", () => {
    const expected = Array.from(
      { length: MAX_LISTS + 1 },
      (_, length) => SANCTIONS_SCREENING_STATUSES.length ** length,
    ).reduce((sum, count) => sum + count, 0);
    expect(ALL_SEQUENCES).toHaveLength(expected);
  });

  test("is clear only when there are lists and every one is clear", () => {
    for (const statuses of ALL_SEQUENCES) {
      const aggregate = aggregateSanctionsScreeningStatus(statuses);
      expect(aggregate === "clear", statuses.join(",")).toBe(
        statuses.length > 0 && statuses.every((status) => status === "clear"),
      );
    }
  });

  test("ranks possible-match over unavailable over incomplete over clear", () => {
    const precedence = [
      "possible-match",
      "unavailable",
      "incomplete",
      "clear",
    ] as const satisfies readonly SanctionsScreeningStatus[];
    expect(new Set(precedence)).toEqual(new Set(SANCTIONS_SCREENING_STATUSES));
    for (const statuses of ALL_SEQUENCES) {
      const expected =
        precedence.find((status) => statuses.includes(status)) ?? "unavailable";
      expect(
        aggregateSanctionsScreeningStatus(statuses),
        statuses.join(","),
      ).toBe(expected);
    }
  });

  test("does not depend on the order of the lists", () => {
    for (const statuses of ALL_SEQUENCES) {
      expect(
        aggregateSanctionsScreeningStatus(statuses.toReversed()),
        statuses.join(","),
      ).toBe(aggregateSanctionsScreeningStatus(statuses));
    }
  });

  test("an incomplete list never lets the screening read as clear", () => {
    for (const statuses of ALL_SEQUENCES) {
      if (statuses.includes("incomplete")) {
        expect(
          aggregateSanctionsScreeningStatus(statuses),
          statuses.join(","),
        ).not.toBe("clear");
      }
    }
  });
});
