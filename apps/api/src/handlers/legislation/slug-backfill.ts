import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import { createStatuteSlug } from "@/api/handlers/legislation/slug";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";

const BATCH_SIZE = 200;

type BackfillRow = {
  id: SafeId<"legislationDocument">;
  eli: string;
  title: string;
};

export type StatuteSlugBackfillResult = {
  written: number;
  /** Documents whose ELI carries no citation tail: no slug can be derived. */
  skipped: number;
  failed: number;
};

/**
 * Assign the public slug to every `legislation_documents` row that predates
 * slug-at-ingest.
 *
 * The slug is a pure function of the ELI and the title, and the column has no
 * uniqueness boundary (a Work's consolidations share one segment), so there
 * is nothing to allocate and no collision to retry: each row is written with
 * what its own identifiers derive.
 *
 * Idempotent (only null-slug rows) and resumable (keyset by id): a row that
 * fails stays null and cannot stall the scan, so re-running retries it.
 */
export const backfillStatuteSlugs = async (
  db: ScopedDb,
): Promise<StatuteSlugBackfillResult> => {
  let lastId: SafeId<"legislationDocument"> | null = null;
  let written = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    const idFilter: SQL | undefined =
      lastId === null ? undefined : gt(legislationDocuments.id, lastId);
    const where = idFilter
      ? and(isNull(legislationDocuments.slug), idFilter)
      : isNull(legislationDocuments.slug);

    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- sequential keyset pagination: the next page cursor (lastId) depends on this query
    const rows: BackfillRow[] = await db((tx) =>
      tx
        .select({
          id: legislationDocuments.id,
          eli: legislationDocuments.eli,
          title: legislationDocuments.title,
        })
        .from(legislationDocuments)
        .where(where)
        .orderBy(asc(legislationDocuments.id))
        .limit(BATCH_SIZE),
    );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const slug = createStatuteSlug({ eli: row.eli, title: row.title });
      if (slug === null) {
        skipped += 1;
        continue;
      }

      try {
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, arrow-body-style -- per-row write; one failure must not abort the batch, and the block body carries the audit-skip directive the require-audit-on-mutation rule scans for
        await db((tx) => {
          // audit: skip — backfills a derived public slug, not user-facing state
          return tx
            .update(legislationDocuments)
            .set({ slug })
            .where(
              and(
                eq(legislationDocuments.id, row.id),
                isNull(legislationDocuments.slug),
              ),
            );
        });
        written += 1;
      } catch (error) {
        failed += 1;
        captureError(error, {
          documentId: row.id,
          step: "backfillStatuteSlugs",
        });
      }
    }

    lastId = rows.at(-1)?.id ?? lastId;
  }

  return { written, skipped, failed };
};
