import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import {
  CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS,
  createCaseLawDecisionSlugCandidate,
  createCaseLawDecisionSlug,
} from "@/api/handlers/case-law/decisions/slug";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";

const BATCH_SIZE = 200;
type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  caseNumber: string;
};

export type CaseLawSlugBackfillResult = {
  written: number;
  failed: number;
};

const isSlugUniqueViolation = (error: unknown): boolean =>
  isPgConstraintError(
    error,
    PG_ERROR.UNIQUE_VIOLATION,
    "case_law_decisions_slug_uidx",
  );

const assignSlug = async (db: ScopedDb, row: BackfillRow): Promise<boolean> => {
  const baseSlug = createCaseLawDecisionSlug(row.caseNumber);

  for (const [
    attemptIndex,
    attempt,
  ] of CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS.entries()) {
    const slug = createCaseLawDecisionSlugCandidate({
      baseSlug,
      identity: row.id,
      attempt,
    });

    try {
      // Compare-and-set on a still-null slug: a concurrent writer may have
      // filled this row, in which case we leave its slug untouched.
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, arrow-body-style -- retry loop must observe this write before retrying; block body carries the audit-skip directive the require-audit-on-mutation rule scans for
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
      if (
        isSlugUniqueViolation(error) &&
        attemptIndex < CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS.length - 1
      ) {
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
 * Slug assignment first tries the familiar case-number base. A collision
 * retries a stable digest of the persisted decision id; the unique index is
 * the allocator, so the backfill never scans the global slug namespace.
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

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential keyset pagination: next page cursor (lastId) depends on this query
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

    for (const row of rows) {
      try {
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- per-row unique-index compare-and-set; one collision must not abort the batch
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
