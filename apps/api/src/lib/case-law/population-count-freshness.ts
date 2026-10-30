import { panic } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";

/** A fold identifies the persisted snapshot; current also includes the complete pending window. */
export const populationCountsFreshnessSchema = v.variant("status", [
  v.object({
    status: v.literal("current"),
    fold: v.number(),
    foldedAt: v.nullable(v.string()),
  }),
  v.object({
    status: v.literal("stale"),
    fold: v.number(),
    foldedAt: v.nullable(v.string()),
  }),
]);

export const populationCountsReadFreshnessSchema = v.union([
  populationCountsFreshnessSchema,
  v.object({ status: v.literal("unavailable") }),
]);

export type PopulationCountsFreshness = v.InferOutput<
  typeof populationCountsFreshnessSchema
>;

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
  freshness: v.InferOutput<typeof populationCountsReadFreshnessSchema>,
): string => {
  switch (freshness.status) {
    case "current":
    case "stale":
      return `${freshness.status}:${freshness.fold}`;
    case "unavailable":
      return freshness.status;
    default:
      freshness satisfies never;
      return panic("Unknown population freshness status");
  }
};
