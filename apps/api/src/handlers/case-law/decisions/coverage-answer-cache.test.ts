import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { isPublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import {
  assembleCaseLawCoverageAnswer,
  type CaseLawCoveragePart,
} from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { CASE_LAW_COVERAGE_PARTS } from "@/api/lib/case-law/coverage-parts";
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
        courts: [],
        publishedDecisions: 0,
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

const PARTS = CASE_LAW_COVERAGE_PARTS;

describe("coverage summary publication eligibility", () => {
  test("a complete answer can replace the stored summary", async () => {
    const computation = await assembleCaseLawCoverageAnswer(answeringReaders());

    expect(computation.complete).toBe(true);
    if ("message" in computation.answer) {
      panic("The readers must produce a coverage answer");
    }
    expect(computation.answer.unreadParts).toEqual([]);
    expect(computation.answer.countries.at(0)?.unreadParts).toEqual([]);
  });

  for (const { storedTotal, storedTotalAsOf, storedDecisions } of [
    { storedTotal: 0, storedTotalAsOf: null, storedDecisions: null },
    {
      storedTotal: 0,
      storedTotalAsOf: new Date("2026-10-25T10:00:00.000Z"),
      storedDecisions: 0,
    },
    {
      storedTotal: 7,
      storedTotalAsOf: new Date("2026-10-25T10:00:00.000Z"),
      storedDecisions: 7,
    },
  ]) {
    test(`stored count ${storedTotal} observed ${storedTotalAsOf?.toISOString() ?? "never"} is published as ${String(storedDecisions)}`, async () => {
      const readers = answeringReaders();
      const sources = await readers.load.readSources();
      const computation = await assembleCaseLawCoverageAnswer({
        ...readers,
        load: {
          ...readers.load,
          readSources: async () =>
            sources.map((source) => ({
              ...source,
              storedTotal,
              storedTotalAsOf,
            })),
        },
      });

      expect(computation.complete).toBe(true);
      if ("message" in computation.answer) {
        panic("The source must produce a coverage answer");
      }
      expect(
        computation.answer.countries.at(0)?.sources.at(0)?.storedDecisions,
      ).toBe(storedDecisions);
    });
  }

  for (const part of PARTS) {
    test(`an answer without ${part} is partial and names it on the country`, async () => {
      const computation = await assembleCaseLawCoverageAnswer(failing(part));

      expect(computation.complete).toBe(false);
      if ("message" in computation.answer) {
        panic("A missing part must leave the rest of the answer");
      }
      expect(computation.answer.unreadParts).toEqual([part]);
      expect(
        computation.answer.countries.map(({ unreadParts }) => unreadParts),
      ).toEqual([[part]]);
    });
  }

  test("parts read once for every country are named on each country", async () => {
    const readers = answeringReaders();
    const [source] = await readers.load.readSources();
    if (source === undefined) {
      panic("The readers must name a source");
    }
    const computation = await assembleCaseLawCoverageAnswer({
      readProvisionProcessing: async () => await Promise.reject(readFailure),
      load: {
        ...readers.load,
        readSources: async () => [
          source,
          {
            ...source,
            id: createSafeId<"caseLawSource">(),
            adapterKey: ADAPTER_KEYS.SK_US,
          },
        ],
        readArrivals: async () => null,
        readCourts: async () => await Promise.reject(readFailure),
      },
    });

    if ("message" in computation.answer) {
      panic("Unread parts must leave the rest of the answer");
    }
    expect(computation.answer.unreadParts).toEqual([
      "arrivals",
      "courts",
      "provision-processing",
    ]);
    // Only an admitted country reads courts; every country lacks the shared parts.
    expect(
      computation.answer.countries.map(({ country, unreadParts }) => [
        country,
        unreadParts,
      ]),
    ).toEqual(
      (["CZE", "SVK"] as const).map((country) => [
        country,
        isPublicCaseLawCountry(country)
          ? ["arrivals", "courts", "provision-processing"]
          : ["arrivals", "provision-processing"],
      ]),
    );
  });

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
