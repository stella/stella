import { Type, type Static } from "@sinclair/typebox";
import { panic } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import {
  CENSUS_AGGREGATE_UNIT,
  CENSUS_OUTCOMES,
  CENSUS_SCOPE_STATUSES,
} from "@/api/lib/case-law/completeness-census-values";
import {
  boundedString,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";

export const CENSUS_VERDICTS = [
  "complete",
  "incomplete",
  "unmeasured",
] as const;
export const CENSUS_WORST_SLICES_LIMIT = 10;
export const CENSUS_YEAR_SUMMARIES_LIMIT = 300;

export const censusSliceSchema = t.Object(
  {
    slice: boundedString(256),
    year: t.Union([Type.Integer(), t.Null()]),
    outcome: t.UnionEnum(CENSUS_OUTCOMES),
    publisher: t.Union([Type.Integer({ minimum: 0 }), t.Null()]),
    stored: Type.Integer({ minimum: 0 }),
    withText: Type.Integer({ minimum: 0 }),
    observedAt: boundedString(128),
    evidenceRef: boundedString(8192),
  },
  { additionalProperties: false },
);
export type CensusSlice = Static<typeof censusSliceSchema>;

export const sourceCensusSchema = t.Object(
  {
    aggregateUnit: t.Literal(CENSUS_AGGREGATE_UNIT, {
      description:
        "Source and year totals count entries across slices, not distinct decisions; one decision can belong to several slices.",
    }),
    verdict: t.UnionEnum(CENSUS_VERDICTS),
    scopeStatus: t.UnionEnum(CENSUS_SCOPE_STATUSES),
    outcome: t.UnionEnum(CENSUS_OUTCOMES),
    evidenceRef: boundedString(8192),
    measuredSlices: Type.Integer({ minimum: 0 }),
    expectedSlices: t.Union([Type.Integer({ minimum: 1 }), t.Null()]),
    shortSlices: Type.Integer({ minimum: 0 }),
    publisher: t.Union([Type.Integer({ minimum: 0 }), t.Null()]),
    stored: Type.Integer({ minimum: 0 }),
    withText: Type.Integer({ minimum: 0 }),
    observedAt: nullableBoundedString(128),
    years: t.Array(
      t.Object(
        {
          year: Type.Integer(),
          slices: Type.Integer(),
          publisher: Type.Integer(),
          stored: Type.Integer(),
          withText: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      { maxItems: CENSUS_YEAR_SUMMARIES_LIMIT },
    ),
    worstSlices: t.Array(censusSliceSchema, {
      maxItems: CENSUS_WORST_SLICES_LIMIT,
    }),
  },
  { additionalProperties: false },
);
export type SourceCensus = Static<typeof sourceCensusSchema>;

type MeasureCensusCountsOptions = {
  listed: number;
  publisherCount: number | undefined;
};

/** Preserve both observations and identify the count that sets the denominator. */
export const measureCensusCounts = ({
  listed,
  publisherCount,
}: MeasureCensusCountsOptions) => {
  if (
    !Number.isSafeInteger(listed) ||
    listed < 0 ||
    (publisherCount !== undefined &&
      (!Number.isSafeInteger(publisherCount) || publisherCount < 0))
  ) {
    return panic("Census publisher count is invalid");
  }
  return {
    outcome:
      publisherCount === undefined || publisherCount < listed
        ? "listing-enumerated"
        : "publisher-count",
    publisherCount: Math.max(publisherCount ?? listed, listed),
    publisherStatedCount: publisherCount ?? null,
    enumeratedCount: listed,
  } as const;
};

// Checked against the public contract at every producer and projection call site.
export const sourceCensusProjection = v.strictObject({
  aggregateUnit: v.literal(CENSUS_AGGREGATE_UNIT),
  verdict: v.picklist(CENSUS_VERDICTS),
  scopeStatus: v.picklist(CENSUS_SCOPE_STATUSES),
  outcome: v.picklist(CENSUS_OUTCOMES),
  evidenceRef: v.string(),
  measuredSlices: v.number(),
  expectedSlices: v.nullable(v.number()),
  shortSlices: v.number(),
  publisher: v.nullable(v.number()),
  stored: v.number(),
  withText: v.number(),
  observedAt: v.nullable(v.string()),
  years: v.array(
    v.strictObject({
      year: v.number(),
      slices: v.number(),
      publisher: v.number(),
      stored: v.number(),
      withText: v.number(),
    }),
  ),
  worstSlices: v.array(
    v.strictObject({
      slice: v.string(),
      year: v.nullable(v.number()),
      outcome: v.picklist(CENSUS_OUTCOMES),
      publisher: v.nullable(v.number()),
      stored: v.number(),
      withText: v.number(),
      observedAt: v.string(),
      evidenceRef: v.string(),
    }),
  ),
}) satisfies v.GenericSchema<SourceCensus>;

type CensusVerdictOptions = {
  slices: readonly CensusSlice[];
  expectedSlices: number | null;
  scopeStatus: SourceCensus["scopeStatus"];
};

export const censusVerdict = ({
  slices,
  expectedSlices,
  scopeStatus,
}: CensusVerdictOptions): SourceCensus["verdict"] =>
  censusVerdictFromSummary({
    measuredSlices: slices.length,
    expectedSlices,
    unmeasuredSlices:
      scopeStatus === "partial-publisher"
        ? Math.max(1, slices.length)
        : slices.filter(
            (slice) =>
              slice.outcome === "none-exposed" || slice.publisher === null,
          ).length,
    shortSlices: slices.filter(censusSliceIsShort).length,
  });

export const censusSliceIsShort = ({
  publisher,
  stored,
  withText,
}: CensusSlice): boolean =>
  // ceil(999 * stored / 1000), without multiplying beyond safe integer precision.
  publisher !== null &&
  (stored < publisher || withText < stored - Math.floor(stored / 1000));

export const countryCensusVerdict = (
  sources: readonly Pick<SourceCensus, "verdict">[],
): SourceCensus["verdict"] => {
  if (
    sources.length === 0 ||
    sources.some(({ verdict }) => verdict === "unmeasured")
  ) {
    return "unmeasured";
  }
  return sources.some(({ verdict }) => verdict === "incomplete")
    ? "incomplete"
    : "complete";
};

// Both the array oracle and PostgreSQL aggregates feed this single verdict rule.
type CensusVerdictSummary = {
  measuredSlices: number;
  expectedSlices: number | null;
  unmeasuredSlices: number;
  shortSlices: number;
};
export const censusVerdictFromSummary = ({
  measuredSlices,
  expectedSlices,
  unmeasuredSlices,
  shortSlices,
}: CensusVerdictSummary): SourceCensus["verdict"] => {
  if (
    expectedSlices === null ||
    expectedSlices < 1 ||
    measuredSlices !== expectedSlices ||
    unmeasuredSlices > 0
  ) {
    return "unmeasured";
  }
  return shortSlices > 0 ? "incomplete" : "complete";
};
