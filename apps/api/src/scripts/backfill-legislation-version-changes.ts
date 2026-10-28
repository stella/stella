/**
 * Compute what each stored consolidation changed against the eligible one
 * before it, for versions stored before ingestion wrote those summaries.
 *
 * Ingestion refreshes the summaries a write can outdate (the version's own
 * and the next version's), so this is a pass over the rows that predate it,
 * and the repair for any refresh that failed. It walks the corpus one Work at
 * a time (`backfillVersionChangesPage`) and runs the refresh ingestion runs.
 *
 * Reports by default, computing and writing nothing. `--apply` computes and
 * writes. The walk is bounded by `--limit` Works and resumable with
 * `--after <source id>/<eli>`, the position a run prints; an apply also keeps
 * its position in the backfill state and resumes there. Idempotent: a Work
 * whose summaries are fresh plans nothing, so a repeated run writes nothing.
 *
 *   # how many summaries are missing or stale
 *   bun run src/scripts/backfill-legislation-version-changes.ts
 *
 *   # compute and write, bounded and resumable
 *   bun run src/scripts/backfill-legislation-version-changes.ts --apply [--limit 100000] [--page 20] [--after <source id>/<eli>]
 */

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  backfillVersionChangesPage,
  decodeVersionChangesCursor,
  encodeVersionChangesCursor,
} from "@/api/handlers/legislation/version-changes-backfill";
import type { VersionChangesCursor } from "@/api/handlers/legislation/version-changes-backfill";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";
import { rejectUnknownFlags } from "@/api/scripts/repair-flags";

/** Works one transaction examines. */
const DEFAULT_PAGE_SIZE = 20;
/** Works one run examines unless `--limit` says otherwise. */
const DEFAULT_LIMIT = 100_000;

const USAGE = `Usage: bun run src/scripts/backfill-legislation-version-changes.ts [options]

  --apply              Compute and write the summaries. Omitted, the run only reports.
  --dry-run            Report only, the default; contradicts --apply.
  --limit <n>          Works this run examines (default ${String(DEFAULT_LIMIT)}).
  --page <n>           Works one transaction examines (default ${String(DEFAULT_PAGE_SIZE)}).
  --after <source/eli> Resume after this Work, as a previous run printed.`;

rejectUnknownFlags({ known: ["limit", "page", "after"], usage: USAGE });

const plan = backfillEntrypoints["legislation-version-changes"]({
  args: process.argv.slice(2),
});
const { apply, limit } = plan;

// A report only reads, so it takes no lane and cannot block a writer.
const { rootDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();
const db: ScopedDb = async (fn) => await withAggregateTransaction(rootDb, fn);

let cursor: VersionChangesCursor | null =
  plan.after === undefined ? null : decodeVersionChangesCursor(plan.after);
let works = 0;
let planned = 0;
let written = 0;
let superseded = 0;
const progress = { reachedEnd: false };
const runtime = apply
  ? plan.open((options) =>
      createScriptBackfillRuntime({ ...options, db: rootDb }),
    )
  : null;

try {
  const pass = await runBackfillPass({
    step: async () => {
      const remaining = limit - works;
      if (runtime === null) {
        const page = await backfillVersionChangesPage({
          db,
          after: cursor,
          pageSize: Math.min(plan.initialSize, remaining),
          apply: false,
        });
        return {
          done: page.cursor === null || works + page.works >= limit,
          sleepMs: 0,
          value: page,
        };
      }
      const result = await runtime.step(
        async ({ tx, size, cursor: persistedCursor }) => {
          const after =
            persistedCursor === null
              ? cursor
              : decodeVersionChangesCursor(persistedCursor);
          const page = await backfillVersionChangesPage({
            db: async (work) => await work(tx),
            after,
            pageSize: Math.min(size, remaining),
            apply: true,
          });
          return {
            cursor:
              page.cursor === null
                ? persistedCursor
                : encodeVersionChangesCursor(page.cursor),
            done: page.cursor === null,
            value: page,
          };
        },
      );
      // The operator limit ends this pass without completing its durable checkpoint.
      return {
        ...result,
        done: result.done || works + result.value.works >= limit,
      };
    },
    onBatch: ({ value: page }) => {
      if (page.cursor === null) {
        progress.reachedEnd = true;
        return;
      }
      cursor = page.cursor;
      works += page.works;
      planned += page.planned;
      written += page.written;
      superseded += page.superseded;
    },
    sleep: Bun.sleep,
  });
  if (pass.isErr()) {
    throw pass.error;
  }
} finally {
  await runtime?.close();
}

const outcome = apply
  ? `, ${written.toLocaleString()} written, ${superseded.toLocaleString()} left to a newer write.`
  : ".";
console.info(
  `${works.toLocaleString()} Works examined: ${planned.toLocaleString()} summaries missing or stale${outcome}`,
);
if (!progress.reachedEnd && cursor !== null) {
  console.info(
    `Stopped at --limit ${String(limit)}; resume with --after ${encodeVersionChangesCursor(cursor)}`,
  );
}
if (!apply) {
  console.info("Report only: nothing written. Re-run with --apply to write.");
}

process.exit(0);
