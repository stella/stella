import type { Transaction } from "@/api/db/root";
import { invalidateSourceStoredTotalTx } from "@/api/handlers/case-law/ingestion/source-totals";
import type { SafeId } from "@/api/lib/branded-types";
import { invalidateCaseLawSitemapShardsTx } from "@/api/lib/case-law/sitemap-shard-refresh";
import { invalidateCaseLawSourceArrivalsTx } from "@/api/lib/case-law/source-arrivals-refresh";
import { lockCaseLawRemovalSnapshots } from "@/api/lib/db/aggregate-lock";
import { invalidatePgFtsBrowseFacetsTx } from "@/api/lib/legal-search/pg-fts-browse-facet-refresh";
import { invalidateCaseLawCoverageSummaryTx } from "@/api/lib/scheduler/tasks/case-law-coverage-refresh";

type CaseLawRemovalSource = {
  id: SafeId<"caseLawSource">;
  country: string;
};

/** Each snapshot owner discards its own pre-removal projection. */
export const invalidateCaseLawRemovalSnapshotsTx = async (
  tx: Transaction,
  { id, country }: CaseLawRemovalSource,
): Promise<void> => {
  await lockCaseLawRemovalSnapshots(tx);
  await invalidatePgFtsBrowseFacetsTx(tx, id);
  await invalidateCaseLawSourceArrivalsTx(tx, id);
  await invalidateCaseLawSitemapShardsTx(tx, country);
  await invalidateCaseLawCoverageSummaryTx(tx);
  await invalidateSourceStoredTotalTx(tx, id);
};
