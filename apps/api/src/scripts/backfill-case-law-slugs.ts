import { rlsDb } from "@/api/db/root";
/**
 * Backfill: assign a unique public slug to every case_law_decisions row
 * that predates slug-at-ingest. Run once before launching the public
 * case-law reader in an environment; safe to re-run (it only processes
 * rows whose `slug` is still null) and resumable (keyset by id).
 *
 *   bun run src/scripts/backfill-case-law-slugs.ts
 *
 * Slug assignment reuses the same helper the ingestion pipeline and the
 * dev seed use, so there is a single source of truth for the slug algorithm.
 */
import { createIngestionDb } from "@/api/db/scoped";
import { backfillCaseLawSlugs } from "@/api/handlers/case-law/decisions/slug-backfill";

console.log("=== BACKFILL CASE-LAW SLUGS ===");

const ingestionDb = createIngestionDb(rlsDb);
const { written, failed } = await backfillCaseLawSlugs(ingestionDb);

console.log(`Done. Wrote ${written} slugs, ${failed} failed.`);

// Non-zero on partial failure: the launch checklist treats this run as
// green only when every decision has a slug.
process.exit(failed === 0 ? 0 : 1);
