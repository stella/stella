/**
 * Store the inline payload of legislation documents that have no corpus write
 * yet in object storage, and record their keys and content hash through the
 * projectability owner, which projects each document into every active
 * generation in the recording transaction
 * (`lib/legal-search/legislation-corpus-storage-backfill.ts`). The case-law
 * counterpart is `backfill-corpus-storage.ts`.
 *
 * Reports by default, writing nothing. `--apply` writes. The walk is bounded
 * by `--limit` documents examined, pauses while the database-load brake holds,
 * and is resumable with `--after <id>`, the last id a run printed.
 * Idempotent: a document with a recorded corpus write leaves the walk.
 *
 *   # how many documents have no corpus write
 *   bun run src/scripts/backfill-legislation-corpus-storage.ts
 *
 *   # write, bounded and resumable
 *   CORPUS_STORAGE_MODE=dual-write LEGAL_CORPUS_S3_BUCKET=... \
 *     bun run src/scripts/backfill-legislation-corpus-storage.ts --apply [--limit 100000] [--page 50] [--after <id>]
 */
import { panic } from "better-result";

import {
  BackfillHeldError,
  runBackfillPass,
} from "@stll/db-load-gate/backfill-pass";
import { decideStart } from "@stll/db-load-gate/health";
import { runScriptWithErrorOutput } from "@stll/errors/script-error";
import { Temporal } from "@stll/time";

import { createScriptBackfillHealthReader } from "@/api/db/backfill-runtime";
import { loadGateHealthConfig } from "@/api/env-online-index";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import {
  advanceLegislationCorpusStorageResume,
  backfillLegislationCorpusStorageRow,
  type LegislationCorpusStorageOutcome,
  type LegislationCorpusStorageResume,
  readLegislationCorpusStoragePage,
} from "@/api/lib/legal-search/legislation-corpus-storage-backfill";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";
import { brandPersistedLegislationDocumentId } from "@/api/lib/safe-id-boundaries";
import { backfillEntrypoints } from "@/api/scripts/backfill-entrypoint";
import { rejectUnknownFlags } from "@/api/scripts/repair-flags";

const USAGE = `Usage: bun run src/scripts/backfill-legislation-corpus-storage.ts [options]

  --apply        Write the objects and record them. Omitted, the run only reports.
  --dry-run      Report only, the default; contradicts --apply.
  --limit <n>    Documents this run examines (default 100000).
  --page <n>     Documents one page reads and writes at once (default 4).
  --after <id>   Resume after this document id, as a previous run printed.`;

rejectUnknownFlags({ known: ["limit", "page", "after"], usage: USAGE });

const documentFailed = failureSink({
  event: "scripts.legislation_corpus_storage_failed",
  expected: [],
});

await runScriptWithErrorOutput(async () => {
  const plan = backfillEntrypoints["legislation-corpus-storage"]({
    args: process.argv.slice(2),
  });
  const { apply, limit } = plan;

  // A report only reads, so it takes no lane and cannot block a writer.
  const { rootDb, ingestionDb } = apply
    ? await enterCaseLawMaintenanceLane()
    : await openCaseLawReadOnlySession();
  const health = createScriptBackfillHealthReader({
    db: rootDb,
    tableName: plan.tableName,
    clock: () => Temporal.Now.instant().epochMilliseconds,
  });
  const healthConfig = loadGateHealthConfig();

  if (apply) {
    await refreshS3();
    await refreshCorpusS3();
  }

  let cursor: SafeId<"legislationDocument"> | null =
    plan.after === undefined
      ? null
      : brandPersistedLegislationDocumentId(plan.after);
  let examined = 0;
  let written = 0;
  let skipped = 0;
  let failed = 0;
  let resume: LegislationCorpusStorageResume<SafeId<"legislationDocument">> = {
    after: cursor,
    held: false,
  };
  const progress = { reachedEnd: false };

  const pass = await runBackfillPass({
    step: async () => {
      // The brake is read before each page: the page's PUTs run outside any
      // transaction, so the runtime's per-transaction admission cannot hold
      // them.
      const verdict = await (async () => {
        try {
          return await health.readVerdict();
        } finally {
          await health.settle();
        }
      })();
      if (
        decideStart(verdict, "backfill_batch", healthConfig).decision === "wait"
      ) {
        throw new BackfillHeldError({
          message: "The database-load brake holds the storage backfill",
          holdUntil: null,
          heldSince: Temporal.Now.instant().epochMilliseconds,
        });
      }
      const rows = await readLegislationCorpusStoragePage(ingestionDb, {
        after: cursor,
        limit: Math.min(plan.initialSize, limit - examined),
      });
      const done = rows.length === 0 || examined + rows.length >= limit;
      const outcomes: (readonly [
        SafeId<"legislationDocument">,
        LegislationCorpusStorageOutcome,
      ])[] = [];
      if (!apply) {
        return { done, sleepMs: 0, value: { rows, outcomes } };
      }
      // The page is small: its documents are written at once.
      outcomes.push(
        // db-await-in-loop: each document's objects and compare-and-set are its own; the page is bounded by --page (default 4)
        ...(await Promise.all(
          rows.map(
            async (row) =>
              [
                row.id,
                await backfillLegislationCorpusStorageRow({
                  db: ingestionDb,
                  row,
                }),
              ] as const,
          ),
        )),
      );
      return { done, sleepMs: 0, value: { rows, outcomes } };
    },
    onBatch: ({ value: { rows, outcomes } }) => {
      const last = rows.at(-1);
      if (last === undefined) {
        progress.reachedEnd = true;
        return;
      }
      cursor = last.id;
      examined += rows.length;
      const failedIds = new Set(
        outcomes.flatMap(([documentId, outcome]) =>
          outcome.type === "failed" ? [documentId] : [],
        ),
      );
      resume = advanceLegislationCorpusStorageResume(
        resume,
        rows.map((row) => ({ id: row.id, failed: failedIds.has(row.id) })),
      );
      for (const [documentId, outcome] of outcomes) {
        switch (outcome.type) {
          case "written":
            written += 1;
            break;
          case "skipped":
            skipped += 1;
            break;
          case "failed":
            failed += 1;
            observeFailure(outcome.error, {
              sink: documentFailed,
              ctx: { documentId },
            });
            break;
          default:
            outcome satisfies never;
            panic(`Unhandled storage backfill outcome: ${String(outcome)}`);
        }
      }
      console.info(
        `  examined=${String(examined)} written=${String(written)} skipped=${String(skipped)} failed=${String(failed)} last=${last.id}`,
      );
    },
    sleep: Bun.sleep,
  });
  if (pass.isErr()) {
    throw pass.error;
  }

  console.info(
    apply
      ? `Done. Examined ${String(examined)} documents with no corpus write: wrote ${String(written)}, skipped ${String(skipped)}, ${String(failed)} failed.`
      : `${String(examined)} documents have no corpus write. Report only: nothing written. Re-run with --apply to write.`,
  );
  if (!progress.reachedEnd && cursor !== null) {
    console.info(
      resume.after === null
        ? `Stopped at --limit ${String(limit)}; resume without --after to retry the failed documents.`
        : `Stopped at --limit ${String(limit)}; resume with --after ${resume.after}${resume.held ? " (before the first failed document, so it is retried)" : ""}.`,
    );
  }
  // Non-zero on partial failure; a rerun retries the documents still unwritten.
  process.exit(failed === 0 ? 0 : 1);
});
