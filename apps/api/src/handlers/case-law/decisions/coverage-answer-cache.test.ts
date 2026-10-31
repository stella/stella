import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  assembleCaseLawCoverageAnswer,
  type CaseLawCoveragePart,
} from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import { unmeasuredSourceCensus } from "@/api/lib/case-law/completeness-census";
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
    readCensus: async () => new Map(),
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
    case "publisher-census":
      return {
        ...readers,
        load: {
          ...readers.load,
          readCensus: async () => await Promise.reject(readFailure),
        },
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
  "publisher-census",
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

describe("publisher census remains independent of the gap ledger", () => {
  for (const { type, verdict, shortSlices, stored } of [
    { type: "unknown", verdict: "unmeasured", shortSlices: 0, stored: 0 },
    { type: "none-recorded", verdict: "complete", shortSlices: 0, stored: 10 },
    { type: "known", verdict: "incomplete", shortSlices: 1, stored: 8 },
  ] as const) {
    test(type, async () => {
      const readers = answeringReaders();
      const computation = await assembleCaseLawCoverageAnswer({
        ...readers,
        load: {
          ...readers.load,
          readYearCompleteness: async (sources) =>
            new Map(
              sources.map((source) => [
                String(source.id),
                {
                  type: "reconciled" as const,
                  summary: { missing: 2, shortSlices: 1, unlistedSlices: 0 },
                  years: [
                    {
                      year: 2024,
                      type: "gaps" as const,
                      missing: 2,
                      shortSlices: 1,
                    },
                  ],
                },
              ]),
            ),
          readCensus: async (sources) =>
            new Map(
              sources.map((source) => [
                String(source.id),
                {
                  ...unmeasuredSourceCensus(ADAPTER_KEYS.CZ_NS),
                  verdict,
                  shortSlices,
                  stored,
                  withText: stored,
                  publisher: type === "unknown" ? null : 10,
                },
              ]),
            ),
        },
      });
      if ("message" in computation.answer) {
        panic("Expected a coverage answer");
      }
      const coverageSource = computation.answer.countries
        .flatMap((country) => country.sources)
        .find((source) => source.adapterKey === ADAPTER_KEYS.CZ_NS);
      expect(coverageSource?.publisherCensus.type).toBe(type);
      expect(coverageSource?.knownGaps).toEqual({
        type: "reconciled",
        summary: { missing: 2, shortSlices: 1, unlistedSlices: 0 },
        years: [{ year: 2024, type: "gaps", missing: 2, shortSlices: 1 }],
      });
      expect(computation.complete).toBe(true);
    });
  }
});
