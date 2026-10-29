import { panic } from "better-result";
import * as v from "valibot";

import {
  CENSUS_AGGREGATE_UNIT,
  CENSUS_OUTCOMES,
  CENSUS_SCOPE_STATUSES,
} from "@/api/lib/case-law/completeness-census-values";
import { boundedString } from "@/api/lib/search/response-text-bounds";

export const CENSUS_VERDICTS = [
  "complete",
  "incomplete",
  "unmeasured",
] as const;
export const CENSUS_WORST_SLICES_LIMIT = 10;
export const CENSUS_YEAR_SUMMARIES_LIMIT = 300;

const integer = v.pipe(v.number(), v.integer());
const nonNegativeInteger = v.pipe(integer, v.minValue(0));
const createCensusSliceSchema = <TText extends v.GenericSchema<string, string>>(
  text: (maxBytes: number) => TText,
) =>
  v.strictObject({
    slice: text(256),
    year: v.nullable(integer),
    outcome: v.picklist(CENSUS_OUTCOMES),
    publisher: v.nullable(nonNegativeInteger),
    stored: nonNegativeInteger,
    withText: nonNegativeInteger,
    observedAt: text(128),
    evidenceRef: text(8192),
  });
const censusSliceSchema = createCensusSliceSchema(boundedString);
export type CensusSlice = v.InferOutput<typeof censusSliceSchema>;

const createSourceCensusSchema = <
  TText extends v.GenericSchema<string, string>,
>(
  text: (maxBytes: number) => TText,
) =>
  v.strictObject({
    aggregateUnit: v.literal(CENSUS_AGGREGATE_UNIT),
    verdict: v.picklist(CENSUS_VERDICTS),
    scopeStatus: v.picklist(CENSUS_SCOPE_STATUSES),
    outcome: v.picklist(CENSUS_OUTCOMES),
    evidenceRef: text(8192),
    measuredSlices: nonNegativeInteger,
    expectedSlices: v.nullable(v.pipe(integer, v.minValue(1))),
    shortSlices: nonNegativeInteger,
    publisher: v.nullable(nonNegativeInteger),
    stored: nonNegativeInteger,
    withText: nonNegativeInteger,
    observedAt: v.nullable(text(128)),
    years: v.pipe(
      v.array(
        v.strictObject({
          year: integer,
          slices: integer,
          publisher: integer,
          stored: integer,
          withText: integer,
        }),
      ),
      v.maxLength(CENSUS_YEAR_SUMMARIES_LIMIT),
    ),
    worstSlices: v.pipe(
      v.array(createCensusSliceSchema(text)),
      v.maxLength(CENSUS_WORST_SLICES_LIMIT),
    ),
  });
export const sourceCensusSchema = createSourceCensusSchema(boundedString);
export type SourceCensus = v.InferOutput<typeof sourceCensusSchema>;

/** Publisher observations supplement the independent reconciled-slice ledger. */
export const createPublisherCensusSchema = <
  TText extends v.GenericSchema<string, string>,
>(
  text: (maxBytes: number) => TText,
) =>
  v.union([
    v.strictObject({
      type: v.literal("unknown"),
      measurement: createSourceCensusSchema(text),
    }),
    v.strictObject({
      type: v.literal("none-recorded"),
      measurement: createSourceCensusSchema(text),
    }),
    v.strictObject({
      type: v.literal("known"),
      measurement: createSourceCensusSchema(text),
    }),
  ]);
export const publisherCensusSchema = createPublisherCensusSchema(boundedString);
export type PublisherCensus = v.InferOutput<typeof publisherCensusSchema>;

export const publisherCensusOf = (
  measurement: SourceCensus,
): PublisherCensus => {
  if (measurement.shortSlices > 0) {
    return { type: "known", measurement };
  }
  switch (measurement.verdict) {
    case "complete":
      return { type: "none-recorded", measurement };
    case "unmeasured":
      return { type: "unknown", measurement };
    case "incomplete":
      return panic("Incomplete publisher census has no short slices");
    default:
      measurement.verdict satisfies never;
      return panic("Unknown publisher census verdict");
  }
};

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
