import { eq, sql } from "drizzle-orm";

import { caseLawPopulationCountsLive, caseLawSources } from "@/api/db/schema";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import { typedPgArray } from "@/api/lib/search/sql";

type PopulationReadDb = Pick<CaseLawPublicReadTransaction, "select">;

/** Every caller supplies the source exclusions used for its population snapshot. */
export const caseLawPopulationRows = (
  db: PopulationReadDb,
  excludedSourceIds: readonly string[],
) =>
  db
    .select({
      kind: caseLawPopulationCountsLive.kind,
      country: caseLawPopulationCountsLive.country,
      sourceId: caseLawPopulationCountsLive.sourceId,
      value: caseLawPopulationCountsLive.value,
      total: caseLawPopulationCountsLive.total,
    })
    .from(caseLawPopulationCountsLive)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, caseLawPopulationCountsLive.sourceId),
    )
    .where(
      sql`(SELECT public.assert_case_law_population_ready())
    AND ${redistributableCaseLawSource}
    AND ${caseLawSources.id} <> ALL(${typedPgArray(excludedSourceIds, "uuid")})`,
    )
    .as("case_law_population_rows");
