import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  assembleCaseLawCoverageAnswer,
  type CaseLawCoveragePart,
  createCaseLawCoverageCache,
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

/** Two reads of one key through the shared cache; how many computations ran. */
const computationsForTwoReads = async (assembly: Assembly) => {
  const cache = createCaseLawCoverageCache(() => 1000);
  let computations = 0;
  const compute = async () => {
    computations += 1;
    return await assembleCaseLawCoverageAnswer(assembly);
  };
  const first = await cache.read("policy", compute);
  await cache.read("policy", compute);
  return { computations, first };
};

describe("the shared coverage answer", () => {
  test("a complete answer is computed once and served again", async () => {
    const { computations, first } =
      await computationsForTwoReads(answeringReaders());

    expect(first.complete).toBe(true);
    expect(computations).toBe(1);
  });

  for (const part of PARTS) {
    test(`an answer without ${part} still answers but is computed again`, async () => {
      const { computations, first } = await computationsForTwoReads(
        failing(part),
      );

      expect("message" in first.answer).toBe(false);
      expect(first.complete).toBe(false);
      expect(computations).toBe(2);
    });
  }

  test("an unavailable answer is computed again", async () => {
    const readers = answeringReaders();
    const { computations, first } = await computationsForTwoReads({
      ...readers,
      load: {
        ...readers.load,
        readSources: async () => await Promise.reject(readFailure),
      },
    });

    expect(first.answer).toEqual({ message: "Coverage is unavailable" });
    expect(computations).toBe(2);
  });
});
