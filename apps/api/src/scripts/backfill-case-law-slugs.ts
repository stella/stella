import { and, asc, eq, gt, isNull, like } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Backfill: assign a unique public slug to every case_law_decisions row
 * that predates slug-at-ingest. Run once before launching the public
 * case-law reader in an environment; safe to re-run (it only processes
 * rows whose `slug` is still null) and resumable (keyset by id).
 *
 *   bun run src/scripts/backfill-case-law-slugs.ts
 *
 * Slug assignment reuses the same helper the ingestion pipeline uses for
 * new rows, so there is a single source of truth for the slug algorithm:
 * derive a base slug from the case number, scan the small set of existing
 * slugs sharing that base, and pick the first free suffix. Rows are filled
 * one at a time so each scan observes the slugs committed just before it,
 * and the partial unique index is the final guard against a race with a
 * concurrent ingest (handled by the compare-and-set + retry below).
 */
import { createIngestionDb } from "@/api/db";
import { rlsDb } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import {
  createAvailableCaseLawDecisionSlug,
  createCaseLawDecisionSlug,
  createCaseLawDecisionSlugCollisionScanPrefix,
} from "@/api/handlers/case-law/decisions/slug";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

const BATCH_SIZE = 200;
const MAX_SLUG_ATTEMPTS = 5;

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
};

const ingestionDb = createIngestionDb(rlsDb);

// Postgres unique_violation: a concurrent ingest grabbed our scanned slug
// between the prefix scan and the update; re-scan and try a higher suffix.
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505";

console.log("=== BACKFILL CASE-LAW SLUGS ===");

let lastId: SafeId<"caseLawDecision"> | null = null;
let written = 0;
let failed = 0;

const assignSlug = async (row: BackfillRow): Promise<void> => {
  const baseSlug = createCaseLawDecisionSlug(row.caseNumber);
  const scanPrefix = createCaseLawDecisionSlugCollisionScanPrefix({
    baseSlug,
    maxSuffix: LIMITS.caseLawSlugCollisionScanLimit + 1,
  });

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const existingSlugRows = await ingestionDb((tx) =>
      tx
        .select({ slug: caseLawDecisions.slug })
        .from(caseLawDecisions)
        .where(like(caseLawDecisions.slug, `${scanPrefix}%`))
        .limit(LIMITS.caseLawSlugCollisionScanLimit),
    );
    const slug = createAvailableCaseLawDecisionSlug(
      baseSlug,
      existingSlugRows.map((scanned) => scanned.slug),
    );

    try {
      // Compare-and-set on a still-null slug: a concurrent ingest may have
      // filled this row, in which case we leave its slug untouched.
      const updated = await ingestionDb((tx) =>
        tx
          .update(caseLawDecisions)
          .set({ slug })
          .where(
            and(eq(caseLawDecisions.id, row.id), isNull(caseLawDecisions.slug)),
          )
          .returning({ id: caseLawDecisions.id }),
      );

      if (updated.length > 0) {
        written += 1;
      }
      return;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < MAX_SLUG_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }
};

const backfillRow = async (row: BackfillRow): Promise<void> => {
  try {
    await assignSlug(row);
  } catch (error) {
    failed += 1;
    captureError(error, { decisionId: row.id, step: "backfillCaseLawSlugs" });
  }
};

while (true) {
  // Keyset by id so a row that fails (stays null) cannot stall the scan;
  // re-run later to retry the stragglers.
  const idFilter: SQL | undefined =
    lastId === null ? undefined : gt(caseLawDecisions.id, lastId);
  const where = idFilter
    ? and(isNull(caseLawDecisions.slug), idFilter)
    : isNull(caseLawDecisions.slug);

  // oxlint-disable-next-line no-await-in-loop -- sequential keyset pagination: next page cursor (lastId) depends on this query
  const rows: BackfillRow[] = await ingestionDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
      })
      .from(caseLawDecisions)
      .where(where)
      .orderBy(asc(caseLawDecisions.id))
      .limit(BATCH_SIZE),
  );

  if (rows.length === 0) {
    break;
  }

  // Assign one row at a time: each slug scan must see the slugs committed
  // by the rows before it to avoid handing out the same suffix twice.
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design (see above)
    await backfillRow(row);
  }

  lastId = rows.at(-1)?.id ?? lastId;
  console.log(`  written=${written} failed=${failed}`);
}

console.log(`Done. Wrote ${written} slugs, ${failed} failed.`);

// Non-zero on partial failure: the launch checklist treats this run as
// green only when every decision has a slug.
process.exit(failed === 0 ? 0 : 1);
