import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import {
  caseLawDecisionSlugCollisionFilter,
  createAvailableCaseLawDecisionSlug,
  createCaseLawDecisionSlug,
} from "@/api/handlers/case-law/decisions/slug";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

const BATCH_SIZE = 200;
const MAX_SLUG_ATTEMPTS = 5;

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
};

export type CaseLawSlugBackfillResult = {
  written: number;
  failed: number;
};

// Postgres unique_violation: a concurrent writer grabbed our scanned slug
// between the prefix scan and the update; re-scan and try a higher suffix.
// Drizzle wraps the driver error, so `isPgError` reads the SQLSTATE off
// `.cause` (errno for Bun SQL, code for pg/PGlite) rather than the wrapper.
const isUniqueViolation = (error: unknown): boolean =>
  isPgError(error, PG_ERROR.UNIQUE_VIOLATION);

const assignSlug = async (db: ScopedDb, row: BackfillRow): Promise<boolean> => {
  const baseSlug = createCaseLawDecisionSlug(row.caseNumber);
  const collisionFilter = caseLawDecisionSlugCollisionFilter({
    baseSlug,
    maxSuffix: LIMITS.caseLawSlugCollisionScanLimit + 1,
  });

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential by design: retry loop, each attempt re-scans after a concurrent writer took the prior candidate
    const existingSlugRows = await db((tx) =>
      tx
        .select({ slug: caseLawDecisions.slug })
        .from(caseLawDecisions)
        .where(collisionFilter)
        .limit(LIMITS.caseLawSlugCollisionScanLimit),
    );
    const slug = createAvailableCaseLawDecisionSlug(
      baseSlug,
      existingSlugRows.map((scanned) => scanned.slug),
    );

    try {
      // Compare-and-set on a still-null slug: a concurrent writer may have
      // filled this row, in which case we leave its slug untouched.
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop, arrow-body-style -- retry loop must observe this write before retrying; block body carries the audit-skip directive the require-audit-on-mutation rule scans for
      const updated = await db((tx) => {
        // audit: skip — backfills a derived public slug, not user-facing state
        return tx
          .update(caseLawDecisions)
          .set({ slug })
          .where(
            and(eq(caseLawDecisions.id, row.id), isNull(caseLawDecisions.slug)),
          )
          .returning({ id: caseLawDecisions.id });
      });

      return updated.length > 0;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < MAX_SLUG_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }

  return false;
};

/**
 * Assign a unique public slug to every `case_law_decisions` row whose
 * `slug` is still null. Shared by the standalone backfill CLI and the
 * dev seed so the slug algorithm has a single source of truth.
 *
 * Slug assignment derives a base slug from the case number, scans the
 * small set of existing slugs sharing that base, and picks the first free
 * suffix. Rows are filled one at a time so each scan observes the slugs
 * committed just before it; the partial unique index is the final guard
 * against a race with a concurrent writer (compare-and-set + retry above).
 *
 * Idempotent (only processes null-slug rows) and resumable (keyset by id):
 * a row that fails stays null and cannot stall the scan, so re-running
 * retries the stragglers.
 */
export const backfillCaseLawSlugs = async (
  db: ScopedDb,
): Promise<CaseLawSlugBackfillResult> => {
  let lastId: SafeId<"caseLawDecision"> | null = null;
  let written = 0;
  let failed = 0;

  while (true) {
    const idFilter: SQL | undefined =
      lastId === null ? undefined : gt(caseLawDecisions.id, lastId);
    const where = idFilter
      ? and(isNull(caseLawDecisions.slug), idFilter)
      : isNull(caseLawDecisions.slug);

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential keyset pagination: next page cursor (lastId) depends on this query
    const rows: BackfillRow[] = await db((tx) =>
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
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design: each slug scan must see the slugs committed by prior rows to avoid handing out the same suffix twice
        const wrote = await assignSlug(db, row);
        if (wrote) {
          written += 1;
        }
      } catch (error) {
        failed += 1;
        captureError(error, {
          decisionId: row.id,
          step: "backfillCaseLawSlugs",
        });
      }
    }

    lastId = rows.at(-1)?.id ?? lastId;
  }

  return { written, failed };
};
