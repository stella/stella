import { panic } from "better-result";

import {
  BackfillHeldError,
  runBackfillPass,
} from "@stll/db-load-gate/backfill-pass";
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
import { decideStart } from "@stll/db-load-gate/health";
import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";
import { Temporal } from "@stll/time";

import {
  createScriptBackfillHealthReader,
  createScriptBackfillRuntime,
} from "@/api/db/backfill-runtime";
import { withLongRunningConnection } from "@/api/db/long-running-connection";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  applyVersionChangesPageTx,
  backfillVersionChangesPage,
  decodeVersionChangesCursor,
  encodeVersionChangesCursor,
  prepareVersionChangesPage,
  VERSION_CHANGE_WORK_PAGE_MAX,
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
let nextPageSize = Math.min(plan.initialSize, VERSION_CHANGE_WORK_PAGE_MAX);
const progress = { reachedEnd: false };
const runVersionChangesPass = async (
  slot: ReturnType<typeof createHeavyWorkSlot> | null,
) => {
  const runtime =
    slot !== null
      ? plan.open((options) => {
          const acquire = async () => {
            const result = await slot.tryAcquire();
            if (result.isErr()) {
              throw result.error;
            }
            return result.value;
          };
          return {
            ...createScriptBackfillRuntime({
              ...options,
              db: rootDb,
              slot: { tryAcquire: acquire, release: slot.release },
            }),
            acquire,
            release: slot.release,
            health: createScriptBackfillHealthReader({
              db: rootDb,
              tableName: options.tableName,
              clock: () => Temporal.Now.instant().epochMilliseconds,
            }),
          };
        })
      : null;

  try {
    const pass = await runBackfillPass({
      step: async () => {
        const remaining = limit - works;
        if (runtime === null) {
          const pagePlan = await backfillVersionChangesPage({
            db,
            after: cursor,
            pageSize: Math.min(plan.initialSize, remaining),
            apply: false,
          });
          if (pagePlan.isErr()) {
            throw pagePlan.error;
          }
          const page = pagePlan.value;
          return {
            done: page.cursor === null || works + page.works >= limit,
            sleepMs: 0,
            value: {
              type: "page",
              page,
              pageSize: Math.min(
                plan.initialSize,
                remaining,
                VERSION_CHANGE_WORK_PAGE_MAX,
              ),
            } as const,
          };
        }

        const verdict = await (async () => {
          try {
            return await runtime.health.readVerdict();
          } finally {
            await runtime.health.settle();
          }
        })();
        if (decideStart(verdict, "backfill_batch").decision === "wait") {
          throw new BackfillHeldError({
            message: "Version comparison is busy",
            holdUntil: null,
            heldSince: Temporal.Now.instant().epochMilliseconds,
          });
        }
        if (!(await runtime.acquire())) {
          throw new BackfillHeldError({
            message: "Version comparison is busy",
            holdUntil: null,
            heldSince: Temporal.Now.instant().epochMilliseconds,
          });
        }
        try {
          const preparedSize = Math.min(nextPageSize, remaining);
          const preparation = await prepareVersionChangesPage({
            db,
            after: cursor,
            pageSize: preparedSize,
          });
          if (preparation.isErr()) {
            throw preparation.error;
          }
          const prepared = preparation.value;
          const result = await runtime.step(
            async ({ tx, size, cursor: persistedCursor }) => {
              const actualAfter =
                persistedCursor === null
                  ? cursor
                  : decodeVersionChangesCursor(persistedCursor);
              const actualKey =
                actualAfter === null
                  ? null
                  : encodeVersionChangesCursor(actualAfter);
              const preparedKey =
                prepared.page.after === null
                  ? null
                  : encodeVersionChangesCursor(prepared.page.after);
              const pageSize = Math.min(
                size,
                remaining,
                VERSION_CHANGE_WORK_PAGE_MAX,
              );
              if (actualKey !== preparedKey || pageSize < preparedSize) {
                return {
                  cursor: persistedCursor,
                  done: false,
                  value: {
                    type: "retry",
                    cursor: actualAfter,
                    pageSize,
                  } as const,
                };
              }
              const page = await applyVersionChangesPageTx(tx, prepared);
              return {
                cursor:
                  page.cursor === null
                    ? persistedCursor
                    : encodeVersionChangesCursor(page.cursor),
                done: page.cursor === null,
                value: { type: "page", page, pageSize } as const,
              };
            },
          );
          return {
            ...result,
            done:
              result.done ||
              (result.value.type === "page" &&
                works + result.value.page.works >= limit),
          };
        } finally {
          await runtime.release();
        }
      },
      onBatch: ({ value }) => {
        switch (value.type) {
          case "retry":
            cursor = value.cursor;
            nextPageSize = value.pageSize;
            return;
          case "page": {
            const { page } = value;
            nextPageSize = value.pageSize;
            if (page.cursor === null) {
              progress.reachedEnd = true;
              return;
            }
            cursor = page.cursor;
            works += page.works;
            planned += page.planned;
            written += page.written;
            superseded += page.superseded;
            return;
          }
          default:
            value satisfies never;
            return panic("Unhandled version change batch result");
        }
      },
      sleep: Bun.sleep,
    });
    if (pass.isErr()) {
      throw pass.error;
    }
  } finally {
    await runtime?.close();
  }
};

if (apply) {
  await withLongRunningConnection(
    {
      statementTimeout: 5000,
      lockTimeout: 1000,
      signal: new AbortController().signal,
    },
    async ({ connection }) => {
      const slot = createHeavyWorkSlot({
        kind: "backfill_batch",
        session: {
          query: async (statement, parameters) =>
            await connection.unsafe<{ acquired: boolean }[]>(statement, [
              ...parameters,
            ]),
        },
      });
      try {
        await runVersionChangesPass(slot);
      } finally {
        await slot.close();
      }
    },
  );
} else {
  await runVersionChangesPass(null);
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
