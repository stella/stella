import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { caseLawPopulationCounts } from "@/api/db/schema";

type RefreshDb = Pick<typeof rootDb, "select">;

/** Decision transactions own the counts; the scheduled task only checks readiness. */
export const refreshPgFtsBrowseFacets = async (
  db: RefreshDb,
  signal?: AbortSignal,
) => {
  const [summary] = await db
    .select({ buckets: sql<number>`count(*)::integer` })
    .from(caseLawPopulationCounts)
    .where(sql`public.assert_case_law_population_ready()`);
  if (!summary) {
    panic("Browse population aggregate returned no row.");
  }
  signal?.throwIfAborted();
  return { buckets: summary.buckets };
};
