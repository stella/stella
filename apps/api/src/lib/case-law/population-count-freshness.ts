import { panic } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { boundedString } from "@/api/lib/search/response-text-bounds";
import { isRecord } from "@/api/lib/type-guards";

/** A PostgreSQL timestamptz rendered as ISO 8601 text. */
const foldedAtSchema = boundedString(64);

/** A fold identifies the persisted snapshot; current also includes the complete pending window. */
export const populationCountsFreshnessSchema = v.variant("status", [
  v.object({
    status: v.literal("current"),
    fold: v.number(),
    foldedAt: v.nullable(foldedAtSchema),
  }),
  v.object({
    status: v.literal("stale"),
    fold: v.number(),
    foldedAt: v.nullable(foldedAtSchema),
  }),
]);

/**
 * What a reader states beside the counts: `building` while the population
 * seed is pending (no count is served), `unavailable` when the read failed.
 */
export const populationCountsReadFreshnessSchema = v.union([
  populationCountsFreshnessSchema,
  v.object({ status: v.literal("building") }),
  v.object({ status: v.literal("unavailable") }),
]);

export type PopulationCountsReadFreshness = v.InferOutput<
  typeof populationCountsReadFreshnessSchema
>;

export type PopulationCountsFreshness = v.InferOutput<
  typeof populationCountsFreshnessSchema
>;

/**
 * Every population read runs `assert_case_law_population_ready()`, which
 * raises this SQLSTATE while the seed repair is pending. Startup admits that
 * state under any release, so it is "not counted yet", never a read failure
 * and never a partial count.
 */
export const isCaseLawPopulationBuilding = (error: unknown): boolean =>
  isPgError(error, PG_ERROR.OBJECT_NOT_IN_PREREQUISITE_STATE);

export const populationCountsFreshness = sql<PopulationCountsFreshness>`(SELECT public.read_case_law_population_freshness())`;

export const readCaseLawPopulationFreshness = async (
  tx: CaseLawPublicReadTransaction,
): Promise<PopulationCountsFreshness> => {
  const row = executedRows(
    await tx.execute(sql`SELECT ${populationCountsFreshness} AS freshness`),
  ).find(isRecord);
  const parsed = v.safeParse(
    populationCountsFreshnessSchema,
    row?.["freshness"],
  );
  if (!parsed.success) {
    return panic("Invalid case-law population freshness");
  }
  return parsed.output;
};

export const populationCountsCacheVersion = (
  freshness: PopulationCountsReadFreshness,
): string => {
  switch (freshness.status) {
    case "current":
    case "stale":
      return `${freshness.status}:${freshness.fold}`;
    case "building":
    case "unavailable":
      return freshness.status;
    default:
      freshness satisfies never;
      return panic("Unknown population freshness status");
  }
};
