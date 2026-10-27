import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  assembleCaseLawCoverageAnswer,
  type CaseLawCoveragePart,
} from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

type Assembly = Parameters<typeof assembleCaseLawCoverageAnswer>[0];

const readFailure = new TypeError("read failed");

/** Readers that all answer, for one admitted CZE source. */
const answeringReaders = (): Assembly => ({
  readProvisionProcessing: async () => [],
  load: {
    excludedSourceIds: [],
    now: new Date("2026-10-25T12:00:00.000Z"),
    readSources: async () => [
      {
        id: createSafeId<"caseLawSource">(),
        adapterKey: ADAPTER_KEYS.CZ_NS,
        enabled: true,
        lastSyncAt: null,
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
        storedTotal: null,
        storedTotalAsOf: null,
        decisionYearFrom: 1993,
        decisionYearTo: 2026,
        pendingTextCount: 0,
      },
    ],
    readArrivals: async () => new Map(),
    readYearCompleteness: async () => new Map(),
    readFacets: async (country) =>
      Result.ok({
        country: [{ value: country, count: 3 }],
        court: [],
        year: [],
      }),
    readCourts: async () => [],
  },
});

/** The same readers with exactly one part failing. */
const failing = (part: CaseLawCoveragePart): Assembly => {
  const readers = answeringReaders();
  switch (part) {
    case "arrivals":
      return {
        ...readers,
        load: { ...readers.load, readArrivals: async () => null },
      };
    case "slice-completeness":
      return {
        ...readers,
        load: {
          ...readers.load,
          readYearCompleteness: async () => await Promise.reject(readFailure),
        },
      };
    case "facets":
      return {
        ...readers,
        load: {
          ...readers.load,
          readFacets: async () => Result.err({ message: "index unavailable" }),
        },
      };
    case "courts":
      return {
        ...readers,
        load: {
          ...readers.load,
          readCourts: async () => await Promise.reject(readFailure),
        },
      };
    case "provision-processing":
      return {
        ...readers,
        readProvisionProcessing: async () => await Promise.reject(readFailure),
      };
    default:
      return part satisfies never;
  }
};

const PARTS = [
  "arrivals",
  "slice-completeness",
  "facets",
  "courts",
  "provision-processing",
] as const satisfies readonly CaseLawCoveragePart[];

describe("coverage summary publication eligibility", () => {
  test("a complete answer can replace the stored summary", async () => {
    const computation = await assembleCaseLawCoverageAnswer(answeringReaders());

    expect(computation.complete).toBe(true);
    expect("message" in computation.answer).toBe(false);
  });

  for (const part of PARTS) {
    test(`an answer without ${part} cannot replace the stored summary`, async () => {
      const computation = await assembleCaseLawCoverageAnswer(failing(part));

      expect("message" in computation.answer).toBe(false);
      expect(computation.complete).toBe(false);
    });
  }

  test("an unavailable answer cannot replace the stored summary", async () => {
    const readers = answeringReaders();
    const computation = await assembleCaseLawCoverageAnswer({
      ...readers,
      load: {
        ...readers.load,
        readSources: async () => await Promise.reject(readFailure),
      },
    });

    expect(computation.answer).toEqual({ message: "Coverage is unavailable" });
    expect(computation.complete).toBe(false);
  });
});
