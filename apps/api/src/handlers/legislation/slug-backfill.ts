import { Result } from "better-result";
import { and, asc, gt, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { createStatuteSlug } from "@stll/api-contract/statute-route";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";

const BATCH_SIZE = 200;

type BackfillRow = {
  id: SafeId<"legislationDocument">;
  eli: string;
  title: string;
};

type SlugAssignment = {
  id: SafeId<"legislationDocument">;
  slug: string;
};

export type StatuteSlugBackfillResult = {
  written: number;
  /** Documents whose ELI carries no citation tail: no slug can be derived. */
  skipped: number;
  failed: number;
};

type StatuteSlugBackfillPageOptions = {
  db: ScopedDb;
  after: SafeId<"legislationDocument"> | null;
  size: number;
};

const readPage = async ({
  db,
  after,
  size,
}: StatuteSlugBackfillPageOptions): Promise<BackfillRow[]> => {
  const where: SQL | undefined =
    after === null
      ? isNull(legislationDocuments.slug)
      : and(
          isNull(legislationDocuments.slug),
          gt(legislationDocuments.id, after),
        );

  return await db((tx) =>
    tx
      .select({
        id: legislationDocuments.id,
        eli: legislationDocuments.eli,
        title: legislationDocuments.title,
      })
      .from(legislationDocuments)
      .where(where)
      .orderBy(asc(legislationDocuments.id))
      .limit(size),
  );
};

/**
 * One UPDATE for the whole page, joined against the derived values. The
 * still-null predicate keeps it a compare-and-set, so a concurrent writer's
 * slug is left alone rather than overwritten.
 */
const writePage = async (
  db: ScopedDb,
  assignments: readonly SlugAssignment[],
): Promise<void> => {
  const values = sql.join(
    assignments.map(({ id, slug }) => sql`(${id}::uuid, ${slug}::varchar)`),
    sql`, `,
  );

  await db((tx) =>
    // audit: skip — backfills a derived public slug, not user-facing state
    tx.execute(sql`
      UPDATE ${legislationDocuments} AS d
      SET slug = v.slug
      FROM (VALUES ${values}) AS v(id, slug)
      WHERE d.id = v.id AND d.slug IS NULL
    `),
  );
};

type BackfillProgress = StatuteSlugBackfillResult & {
  after: SafeId<"legislationDocument"> | null;
};

const planPage = (rows: readonly BackfillRow[]) => {
  const assignments: SlugAssignment[] = [];
  let skipped = 0;
  for (const row of rows) {
    const slug = createStatuteSlug({ eli: row.eli, title: row.title });
    if (slug === null) {
      skipped += 1;
      continue;
    }
    assignments.push({ id: row.id, slug });
  }
  return { assignments, skipped };
};

/**
 * One bounded page; a tx-bound db callback keeps writes and the caller's
 * checkpoint atomic. Failures propagate so that neither can commit alone.
 */
export const backfillStatuteSlugsPage = async (
  options: StatuteSlugBackfillPageOptions,
) => {
  const rows = await readPage(options);
  const { assignments, skipped } = planPage(rows);
  if (assignments.length > 0) {
    await writePage(options.db, assignments);
  }
  return {
    cursor: rows.at(-1)?.id ?? options.after,
    done: rows.length === 0,
    written: assignments.length,
    skipped,
    failed: 0,
  };
};

const backfillFrom = async (
  db: ScopedDb,
  progress: BackfillProgress,
): Promise<StatuteSlugBackfillResult> => {
  const rows = await readPage({ db, after: progress.after, size: BATCH_SIZE });
  if (rows.length === 0) {
    return {
      written: progress.written,
      skipped: progress.skipped,
      failed: progress.failed,
    };
  }

  const { assignments, skipped } = planPage(rows);

  const write =
    assignments.length === 0
      ? Result.ok(undefined)
      : await Result.tryPromise({
          try: async () => await writePage(db, assignments),
          catch: (cause: unknown) => cause,
        });

  if (Result.isError(write)) {
    // One page's failure must not stall the scan: those rows stay null and a
    // re-run retries them, so the walk moves on past this cursor.
    captureError(write.error, {
      after: progress.after ?? "start",
      step: "backfillStatuteSlugs",
    });
  }

  // A keyset walk is sequential by construction: the next page's cursor is
  // the last id this page returned.
  return await backfillFrom(db, {
    after: rows.at(-1)?.id ?? progress.after,
    written:
      progress.written + (Result.isError(write) ? 0 : assignments.length),
    skipped: progress.skipped + skipped,
    failed: progress.failed + (Result.isError(write) ? assignments.length : 0),
  });
};

/**
 * Assign the public slug to every `legislation_documents` row that predates
 * slug-at-ingest.
 *
 * The slug is a pure function of the ELI and the title, and the column has no
 * uniqueness boundary (a Work's consolidations share one segment), so there
 * is nothing to allocate and no collision to retry: each page derives its
 * values and writes them in one statement.
 *
 * Idempotent (only null-slug rows) and resumable (keyset by id): a page that
 * fails stays null and cannot stall the scan, so re-running retries it.
 */
export const backfillStatuteSlugs = async (
  db: ScopedDb,
): Promise<StatuteSlugBackfillResult> =>
  await backfillFrom(db, { after: null, written: 0, skipped: 0, failed: 0 });
