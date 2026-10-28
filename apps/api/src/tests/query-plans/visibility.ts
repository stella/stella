import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

const RETRY_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;

type VisibilityOptions = {
  readonly db: GatedTestDb;
  /** Resolved through the session's search_path. */
  readonly table: string;
  readonly timeoutMs?: number;
};

type PageCounts = { readonly pages: number; readonly allVisible: number };

const readPageCounts = async (
  db: GatedTestDb,
  table: string,
): Promise<PageCounts> => {
  const row = executedRows(
    await db.execute(sql`SELECT relpages, relallvisible
      FROM pg_class WHERE oid = ${table}::regclass`),
  ).at(0);
  if (
    !isRecord(row) ||
    typeof row["relpages"] !== "number" ||
    typeof row["relallvisible"] !== "number"
  ) {
    return panic(`Missing page counts for ${table}`);
  }
  return { pages: row["relpages"], allVisible: row["relallvisible"] };
};

/**
 * Vacuums `table` until every page is all-visible, the precondition for an
 * index-only scan to report zero heap fetches.
 *
 * VACUUM marks a page all-visible only once no open snapshot in the database
 * can still see its rows as in progress, so a concurrent suite's transaction
 * defers the mark. This retries until those snapshots end and fails with the
 * page counts when they outlast `timeoutMs`, rather than letting a plan
 * assertion fail on visibility state.
 */
export const vacuumUntilAllVisible = async ({
  db,
  table,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: VisibilityOptions): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    await db.execute(sql`VACUUM (ANALYZE) ${sql.identifier(table)}`);
    const counts = await readPageCounts(db, table);
    if (counts.allVisible === counts.pages) {
      return;
    }
    if (performance.now() >= deadline) {
      return panic(
        `Visibility precondition: ${table} has ${counts.allVisible} of ${counts.pages} pages all-visible after ${timeoutMs} ms; an open snapshot in this database holds back VACUUM`,
      );
    }
    await Bun.sleep(RETRY_INTERVAL_MS);
  }
};
