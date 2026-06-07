/**
 * One-off backfill: materialize `citation_authority` / `citation_count`
 * across the whole case-law corpus.
 *
 * The post-ingestion citation pass (resolve-citations.ts) keeps this
 * fresh going forward; this script seeds it for an existing corpus and
 * can be re-run to refresh the time-decayed values on demand.
 *
 *   bun run src/scripts/backfill-citation-authority.ts
 */
import { rootDb } from "@/api/db/root";
import { recomputeCitationAuthorityForAll } from "@/api/handlers/case-law/citation-authority";

console.log("=== BACKFILL CITATION AUTHORITY ===");

const updated = await rootDb.transaction((tx) =>
  recomputeCitationAuthorityForAll(tx),
);

console.log(`Citation authority materialized for ${updated} cited decisions.`);

process.exit(0);
