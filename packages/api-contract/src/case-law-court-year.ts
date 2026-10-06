import * as v from "valibot";

import { COURT_TIER_LABELS } from "./case-law-court-tiers";

export const CASE_LAW_COURT_YEAR_BUCKET_LIMIT = 400;

const count = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);

/** Whole-query decision counts; unavailable index signals remain explicit. */
export const caseLawCourtYearSchema = v.nullable(
  v.strictObject({
    buckets: v.pipe(
      v.array(
        v.strictObject({
          court: v.string(),
          courtName: v.string(),
          courtAbbreviation: v.nullable(v.string()),
          tier: v.picklist(COURT_TIER_LABELS),
          year: v.pipe(v.number(), v.integer()),
          count,
          citationSum: v.nullable(count),
          treatment: v.null(),
        }),
      ),
      v.maxLength(CASE_LAW_COURT_YEAR_BUCKET_LIMIT),
    ),
    truncated: v.boolean(),
  }),
);

export type CaseLawCourtYear = v.InferOutput<typeof caseLawCourtYearSchema>;
