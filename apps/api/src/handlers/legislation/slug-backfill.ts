import { Result, TaggedError } from "better-result";
import { and, asc, gt, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { createStatuteSlug } from "@stll/api-contract/statute-route";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

class StatuteSlugPageError extends TaggedError("StatuteSlugPageError")<{
  message: string;
  cause: unknown;
}> {}

type BackfillRow = {
  id: SafeId<"legislationDocument">;
  eli: string;
  title: string;
};

type SlugAssignment = {
  id: SafeId<"legislationDocument">;
  slug: string;
};

type StatuteSlugBackfillPageOptions = {
  db: ScopedDb;
  after: SafeId<"legislationDocument"> | null;
  size: number;
  capture?: typeof captureError;
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
): Promise<number> => {
  const values = sql.join(
    assignments.map(({ id, slug }) => sql`(${id}::uuid, ${slug}::varchar)`),
    sql`, `,
  );

  const result = await db((tx) =>
    // audit: skip — backfills a derived public slug, not user-facing state
    tx.execute(sql`
      UPDATE ${legislationDocuments} AS d
      SET slug = v.slug
      FROM (VALUES ${values}) AS v(id, slug)
      WHERE d.id = v.id AND d.slug IS NULL
      RETURNING d.id
    `),
  );
  return executedRows(result).length;
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
 * checkpoint atomic. A savepoint isolates a poison page so later pages remain
 * reachable; failed rows stay null and are retried by the next complete pass.
 */
export const backfillStatuteSlugsPage = async (
  options: StatuteSlugBackfillPageOptions,
) => {
  const rows = await readPage(options);
  const { assignments, skipped } = planPage(rows);
  let failed = 0;
  let written = 0;
  if (assignments.length > 0) {
    const write = await Result.tryPromise({
      try: async () =>
        await options.db(
          async (tx) =>
            await tx.transaction(
              async (savepoint) =>
                await writePage(
                  async (work) => await work(savepoint),
                  assignments,
                ),
            ),
        ),
      catch: (cause: unknown) => cause,
    });
    if (Result.isError(write)) {
      // Statement cancellation shrinks and retries the page through the gate.
      if (isPgError(write.error, PG_ERROR.QUERY_CANCELED)) {
        return Result.err(
          new StatuteSlugPageError({
            message: "Statute slug page was canceled",
            cause: write.error,
          }),
        );
      }
      (options.capture ?? captureError)(write.error, {
        after: options.after ?? "start",
        step: "backfillStatuteSlugs",
        failed: String(assignments.length),
      });
      failed = assignments.length;
    } else {
      written = write.value;
    }
  }
  return Result.ok({
    cursor: rows.at(-1)?.id ?? options.after,
    done: rows.length === 0,
    written,
    skipped,
    failed,
  });
};
