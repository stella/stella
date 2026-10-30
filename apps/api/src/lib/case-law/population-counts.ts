import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { caseLawPopulationCountsLive } from "@/api/db/schema";

type PopulationReadDb = Pick<typeof rootDb, "select">;

/** The live owner includes committed deltas that have not been folded yet. */
export const readCaseLawPopulationBucketCount = async (
  db: PopulationReadDb,
  signal?: AbortSignal,
) => {
  const [summary] = await db
    .select({ buckets: sql<number>`count(*)::integer` })
    .from(caseLawPopulationCountsLive)
    .where(sql`public.assert_case_law_population_ready()`);
  if (!summary) {
    panic("Browse population aggregate returned no row.");
  }
  signal?.throwIfAborted();
  return { buckets: summary.buckets };
};
