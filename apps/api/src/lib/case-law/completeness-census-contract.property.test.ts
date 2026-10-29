import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  type CensusSlice,
  censusSliceIsShort,
  censusVerdict,
  countryCensusVerdict,
  measureCensusCounts,
} from "./completeness-census-contract";

const slice = (
  counts: Pick<CensusSlice, "publisher" | "stored" | "withText">,
): CensusSlice => ({
  slice: "2026",
  year: 2026,
  outcome: "publisher-count",
  observedAt: "2026-10-16T00:00:00Z",
  evidenceRef: "https://publisher.example/count",
  ...counts,
});

test("an enumeration above the publisher statement preserves both counts", () => {
  expect(measureCensusCounts({ listed: 2, publisherCount: 1 })).toEqual({
    publisherCount: 2,
    publisherStatedCount: 1,
    enumeratedCount: 2,
    outcome: "listing-enumerated",
  });
});

test("census-count-provenance-keeps-stated-and-enumerated-observations", () => {
  assertProperty(
    "census-count-provenance-keeps-stated-and-enumerated-observations",
    fc.property(
      fc.oneof(
        fc.constantFrom(1, 2, 1000, Number.MAX_SAFE_INTEGER - 1),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER - 1 }),
      ),
      (listed) => {
        const observations = [
          {
            publisherCount: listed - 1,
            denominator: listed,
            outcome: "listing-enumerated",
          },
          {
            publisherCount: listed,
            denominator: listed,
            outcome: "publisher-count",
          },
          {
            publisherCount: listed + 1,
            denominator: listed + 1,
            outcome: "publisher-count",
          },
          {
            publisherCount: undefined,
            denominator: listed,
            outcome: "listing-enumerated",
          },
        ] as const;
        for (const observation of observations) {
          expect(
            measureCensusCounts({
              listed,
              publisherCount: observation.publisherCount,
            }),
          ).toEqual({
            publisherCount: observation.denominator,
            publisherStatedCount: observation.publisherCount ?? null,
            enumeratedCount: listed,
            outcome: observation.outcome,
          });
        }
      },
    ),
  );
});

test("a missing measurement or empty universe never authorizes launch", () => {
  expect(
    censusVerdict({
      slices: [],
      expectedSlices: 0,
      scopeStatus: "full-publisher",
    }),
  ).toBe("unmeasured");
  expect(
    censusVerdict({
      slices: [],
      expectedSlices: null,
      scopeStatus: "full-publisher",
    }),
  ).toBe("unmeasured");
  expect(
    censusVerdict({
      slices: [],
      expectedSlices: 1,
      scopeStatus: "full-publisher",
    }),
  ).toBe("unmeasured");
  expect(countryCensusVerdict([])).toBe("unmeasured");
});

test("census-short-or-unmeasured-never-complete", () => {
  assertProperty(
    "census-short-or-unmeasured-never-complete",
    fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.nat({ max: 1_000_000 }),
      fc.constantFrom(
        "short",
        "textless",
        "none-exposed",
        "identity-unproven",
        "missing-count",
        "missing-slice",
        "partial-publisher",
      ),
      (publisher, extra, defect) => {
        const complete = slice({
          publisher,
          stored: publisher + extra,
          withText: publisher + extra,
        });
        let affected = complete;
        switch (defect) {
          case "short":
            affected = slice({
              publisher,
              stored: publisher - 1,
              withText: publisher - 1,
            });
            break;
          case "textless":
            affected = slice({ publisher, stored: publisher, withText: 0 });
            break;
          case "identity-unproven":
            affected = { ...complete, outcome: "identity-unproven" };
            break;
          case "none-exposed":
            affected = { ...complete, outcome: "none-exposed" };
            break;
          case "missing-count":
            affected = { ...complete, publisher: null };
            break;
          case "missing-slice":
          case "partial-publisher":
            break;
          default:
            defect satisfies never;
        }
        const verdict = censusVerdict({
          slices: [complete, affected],
          expectedSlices: defect === "missing-slice" ? 3 : 2,
          scopeStatus:
            defect === "partial-publisher"
              ? "partial-publisher"
              : "full-publisher",
        });
        expect(verdict).not.toBe("complete");
        expect(
          countryCensusVerdict([{ verdict: "complete" }, { verdict }]),
        ).not.toBe("complete");
      },
    ),
  );
});

test("census-text-threshold-exact-safe-integers", () => {
  assertProperty(
    "census-text-threshold-exact-safe-integers",
    fc.property(
      fc.oneof(
        fc.constantFrom(0, 1, 999, 1000, 1001, Number.MAX_SAFE_INTEGER),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      ),
      fc.integer({ min: -1, max: 1 }),
      (stored, offset) => {
        const exactMinimum = (BigInt(stored) * 999n + 999n) / 1000n;
        const withText = Math.max(
          0,
          Math.min(stored, Number(exactMinimum) + offset),
        );
        const measured = slice({ publisher: stored, stored, withText });
        const isShort = BigInt(withText) * 1000n < BigInt(stored) * 999n;
        expect(censusSliceIsShort(measured)).toBe(isShort);
        expect(
          censusVerdict({
            slices: [measured],
            expectedSlices: 1,
            scopeStatus: "full-publisher",
          }),
        ).toBe(isShort ? "incomplete" : "complete");
      },
    ),
  );
});

test("unproven court identity cannot establish a missing decision or completeness", () => {
  const observation = {
    slice: "2026",
    year: 2026,
    outcome: "identity-unproven",
    publisher: 1,
    stored: 0,
    withText: 0,
    observedAt: "2026-10-16T00:00:00Z",
    evidenceRef: "https://publisher.example/count",
  } as const satisfies CensusSlice;
  expect(
    censusVerdict({
      slices: [observation],
      expectedSlices: 1,
      scopeStatus: "full-publisher",
    }),
  ).toBe("unmeasured");
});
