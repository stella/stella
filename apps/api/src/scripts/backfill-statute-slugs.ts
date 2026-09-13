/**
 * Backfill: assign the public slug to every legislation_documents row that
 * predates slug-at-ingest. Run once before serving readable statute URLs in
 * an environment; safe to re-run (it only processes rows whose `slug` is
 * still null) and resumable (keyset by id).
 *
 *   bun run src/scripts/backfill-statute-slugs.ts
 *
 * Slug derivation reuses the helper the ingestion pipeline uses, so there is
 * a single source of truth for the algorithm.
 */
import { backfillStatuteSlugs } from "@/api/handlers/legislation/slug-backfill";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";

// Hold the maintenance lane before the first statement: operator passes over
// the corpus tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();

console.log("=== BACKFILL STATUTE SLUGS ===");

const { written, skipped, failed } = await backfillStatuteSlugs(ingestionDb);

console.log(
  `Done. Wrote ${written} slugs, skipped ${skipped} (no citation in the ELI), ${failed} failed.`,
);

// Non-zero on failure: a launch treats this run as green only when every
// document that can carry a slug has one.
process.exit(failed === 0 ? 0 : 1);
