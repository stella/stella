import * as v from "valibot";

import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

/**
 * Deployment-owned expectations for the case-law data invariants.
 *
 * A leaf module (valibot and a constant map only) because `env-base-schema`
 * imports it, and every project that typechecks the base environment would
 * otherwise pull the invariant graph in behind it.
 *
 * Both values are JSON arrays rather than objects keyed by adapter or country:
 * an array keeps a duplicate visible to the check below instead of letting
 * `JSON.parse` keep the last one silently.
 */

/** Bounds the work one invariant run spends on canary searches. */
export const CASE_LAW_CANARY_LIMIT = 32;

const nonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0));

const dailyBandSchema = v.pipe(
  v.strictObject({
    adapterKey: v.picklist(Object.values(ADAPTER_KEYS)),
    min: nonNegativeInteger,
    max: nonNegativeInteger,
  }),
  v.check(({ min, max }) => min <= max, "min must not exceed max"),
);

export type CaseLawDailyBand = v.InferOutput<typeof dailyBandSchema>;

const canarySchema = v.strictObject({
  country: v.pipe(v.string(), v.trim(), v.toUpperCase(), v.minLength(2)),
  query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(256)),
});

export type CaseLawCanary = v.InferOutput<typeof canarySchema>;

const jsonArray = <Item extends v.GenericSchema>(item: Item, name: string) =>
  v.optional(
    v.pipe(
      v.string(),
      v.parseJson(undefined, `${name} must be valid JSON`),
      v.array(item),
    ),
    "[]",
  );

export const caseLawDailyBandsEnvSchema = v.pipe(
  jsonArray(dailyBandSchema, "DATA_INVARIANT_CASE_LAW_DAILY_BANDS"),
  v.check(
    (bands) =>
      new Set(bands.map(({ adapterKey }) => adapterKey)).size === bands.length,
    "DATA_INVARIANT_CASE_LAW_DAILY_BANDS must name each adapter once",
  ),
);

export const caseLawCanariesEnvSchema = v.pipe(
  jsonArray(canarySchema, "DATA_INVARIANT_CASE_LAW_CANARIES"),
  v.maxLength(
    CASE_LAW_CANARY_LIMIT,
    `DATA_INVARIANT_CASE_LAW_CANARIES holds at most ${CASE_LAW_CANARY_LIMIT} queries`,
  ),
);
