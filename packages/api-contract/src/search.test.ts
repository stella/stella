import { describe, expect, test } from "bun:test";

import {
  caseLawPageOutcome,
  type CaseLawSearchPaginationOutcome,
  countedSearchTotal,
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
  SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET,
  SEARCH_PHASE_NOT_DUE,
  SEARCH_TOTAL_NOT_COUNTED,
  SEARCH_TOTAL_TYPE,
  type SearchPaginationOutcome,
  type SearchPhaseCompletion,
} from "./search";

describe("search total", () => {
  test("represents counted and uncounted results without null", () => {
    expect(countedSearchTotal(SEARCH_TOTAL_TYPE.EXACT, 3)).toEqual({
      type: "exact",
      count: 3,
    });
    expect(countedSearchTotal(SEARCH_TOTAL_TYPE.ESTIMATE, 4)).toEqual({
      type: "estimate",
      count: 4,
    });
    expect(SEARCH_TOTAL_NOT_COUNTED).toEqual({ type: "not_counted" });
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    "rejects invalid counts: %s",
    (count) => {
      expect(() => countedSearchTotal(SEARCH_TOTAL_TYPE.EXACT, count)).toThrow(
        "non-negative safe integer",
      );
    },
  );
});

/** Every way a scan can stop. */
const SCAN_STOPS = [
  SEARCH_PAGINATION_COMPLETE,
  SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
] as const;
// Every member of the union is listed: a stop added to the type and not
// here fails to compile rather than going untested.
true satisfies SearchPaginationOutcome extends (typeof SCAN_STOPS)[number]
  ? true
  : never;

/** Every way the partial-match phase can end, its own stops included. */
const PHASE_ENDS: readonly SearchPhaseCompletion[] = [
  SEARCH_PHASE_NOT_DUE,
  ...SCAN_STOPS.map((outcome) => ({ state: "finished" as const, outcome })),
  { state: "skipped" },
];

const isComplete = (outcome: { type: string }) =>
  outcome.type === SEARCH_PAGINATION_COMPLETE.type;

describe("a case-law page's outcome, over every phase's stop", () => {
  const cases = SCAN_STOPS.flatMap((scan) =>
    PHASE_ENDS.map((partialMatches) => ({ scan, partialMatches })),
  );

  test.each(cases)(
    "scan $scan.type / partial matches $partialMatches.state",
    ({ scan, partialMatches }) => {
      const outcome = caseLawPageOutcome({ scan, partialMatches });
      const partialComplete =
        partialMatches.state === "not_due" ||
        (partialMatches.state === "finished" &&
          isComplete(partialMatches.outcome));
      // Complete exactly when every phase let it be.
      expect(isComplete(outcome)).toBe(isComplete(scan) && partialComplete);
      // A stop is the first one the page met: the scan's, then the phase's.
      if (!isComplete(scan)) {
        expect(outcome).toEqual(
          partialMatches.state === "skipped"
            ? SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET
            : scan,
        );
      }
    },
  );

  test("a partial pass that finished at its own budget stops the page", () => {
    expect(
      caseLawPageOutcome({
        scan: SEARCH_PAGINATION_COMPLETE,
        partialMatches: {
          state: "finished",
          outcome: SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET,
        },
      }),
    ).toEqual(SEARCH_PAGINATION_TRUNCATED_EXCLUSION_BUDGET);
  });

  test("every page outcome is one some combination of stops reaches", () => {
    const reached = new Set(
      cases.map((phases) => JSON.stringify(caseLawPageOutcome(phases))),
    );
    const all: readonly CaseLawSearchPaginationOutcome[] = [
      ...SCAN_STOPS,
      SEARCH_PAGINATION_TRUNCATED_PARTIAL_MATCHES_BUDGET,
    ];
    expect(reached).toEqual(
      new Set(all.map((outcome) => JSON.stringify(outcome))),
    );
  });
});
