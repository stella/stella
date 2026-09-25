import { panic, Result } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Backfill: copy existing canonical text/sections/AST from the Postgres
 * columns into object storage and record the keys + content hash. Run
 * once before flipping reads to corpus storage; safe to re-run (it only
 * processes rows whose `text_s3_key` is still null).
 *
 *   CORPUS_STORAGE_MODE=dual-write LEGAL_CORPUS_S3_BUCKET=... \
 *     bun run src/scripts/backfill-corpus-storage.ts
 *
 * With `--include-stale-empty` it also repairs rows whose objects were
 * written by a metadata-first ingest and never rewritten when the
 * document arrived: their columns hold the document, their keys still
 * point at the empty payload, and `text_s3_key IS NOT NULL` hides them
 * from the pass above. The empty payload's content hash identifies
 * them. Count them first with the same predicate:
 *
 *   SELECT count(*) FROM case_law_decisions
 *   WHERE text_s3_key IS NOT NULL
 *     AND fulltext IS NOT NULL AND fulltext <> ''
 *     AND content_hash IN (<EMPTY_CORPUS_CONTENT_HASHES>);
 */
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
} from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import {
  timestampCasToken,
  type TimestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { settleReservedCaseLawCorpusUpload } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { synchronizeLockedCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { openCorpusPackBatch } from "@/api/lib/legal-search/corpus-pack-batch";
import type {
  CorpusPackBatch,
  CorpusPackBatchOutcome,
} from "@/api/lib/legal-search/corpus-pack-batch";
import {
  corpusMirrorColumns,
  EMPTY_CORPUS_CONTENT_HASHES,
  storedCorpusWrite,
} from "@/api/lib/legal-search/corpus-storage";
import type {
  DecisionSection,
  EmptyAst,
} from "@/api/lib/legal-search/document-types";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();

const BATCH_SIZE = 50;
const CONCURRENCY = 4;

const includeStaleEmpty = process.argv.includes("--include-stale-empty");

type BackfillRow = {
  id: SafeId<"caseLawDecision">;
  country: string;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  documentAst: DocumentAst | EmptyAst | null;
  contentHash: string | null;
  textS3Key: string | null;
  normalizedS3Key: string | null;
  astS3Key: string | null;
  updatedAtToken: TimestampCasToken;
};

/** Never written to object storage. */
const missingCorpusObjects = isNull(caseLawDecisions.textS3Key);

/**
 * Written by a metadata-first ingest and never rewritten: the columns
 * hold a document, the keys still point at the empty payload the ingest
 * wrote before the document existed.
 */
const staleEmptyCorpusObjects = and(
  isNotNull(caseLawDecisions.textS3Key),
  isNotNull(caseLawDecisions.fulltext),
  ne(caseLawDecisions.fulltext, ""),
  inArray(caseLawDecisions.contentHash, [...EMPTY_CORPUS_CONTENT_HASHES]),
);

const rowsToBackfill: SQL | undefined = includeStaleEmpty
  ? or(missingCorpusObjects, staleEmptyCorpusObjects)
  : missingCorpusObjects;
const eligibleForBackfill = and(
  rowsToBackfill,
  isNull(caseLawDecisions.redactedAt),
);

await refreshS3();
await refreshCorpusS3();

console.log(
  `=== BACKFILL CORPUS STORAGE ===${includeStaleEmpty ? " (including stale empty payloads)" : ""}`,
);

let lastId: SafeId<"caseLawDecision"> | null = null;
let written = 0;
let skipped = 0;
let failed = 0;

const enqueueBackfillRow = (batch: CorpusPackBatch, row: BackfillRow): void => {
  const ownerPredicate = and(
    eq(caseLawDecisions.id, row.id),
    isNull(caseLawDecisions.redactedAt),
    sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${row.contentHash}`,
    timestampMatchesCasToken(caseLawDecisions.updatedAt, row.updatedAtToken),
  );
  batch.enqueue({
    decisionId: row.id,
    jurisdiction: row.country,
    payload: {
      text: row.fulltext,
      sections: row.sections,
      ast: row.documentAst,
    },
    stored: storedCorpusWrite(row),
    settle: async ({ intentId, written: packed }) => {
      const outcome = await settleReservedCaseLawCorpusUpload({
        apply: async ({ projectionLock, tx, written: uploaded }) => {
          // audit: skip — one-time corpus storage repair; derived state
          const recorded = await tx
            .update(caseLawDecisions)
            .set(
              corpusMirrorColumns({
                status: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
                written: uploaded,
              }),
            )
            .where(ownerPredicate)
            .returning({ id: caseLawDecisions.id });
          if (recorded.length > 0 && projectionLock !== null) {
            await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
              lock: projectionLock,
              subject: { family: "case_law", entityId: row.id },
            });
          }
          return { type: recorded.length > 0 ? "applied" : "superseded" };
        },
        decisionId: row.id,
        intentId,
        preflight: async (tx) =>
          Boolean(
            (
              await tx
                .select({ id: caseLawDecisions.id })
                .from(caseLawDecisions)
                .where(ownerPredicate)
                .limit(1)
            ).at(0),
          ),
        scopedDb: ingestionDb,
        written: packed,
      });
      switch (outcome.type) {
        case "applied":
          return { type: "settled" };
        case "superseded":
        case "intent-reclaimed":
          // A refused CAS is not success: the row changed under the scan and
          // still points at its own payload, so nothing was recorded. The
          // next run of the script sees it again.
          return { type: "retry" };
        case "redacted-or-missing":
          return { type: "redacted-or-missing" };
        default:
          outcome satisfies never;
          return panic(`Unhandled settlement: ${String(outcome)}`);
      }
    },
  });
};

const recordOutcome = (
  decisionId: SafeId<"caseLawDecision">,
  outcome: CorpusPackBatchOutcome,
): void => {
  switch (outcome.type) {
    case "settled":
      written += 1;
      return;
    case "redacted-or-missing":
    case "busy":
    case "retry":
      skipped += 1;
      return;
    case "failed":
      failed += 1;
      captureError(outcome.error, {
        decisionId,
        step: "backfillCorpusStorage",
      });
      return;
    default:
      outcome satisfies never;
      return panic(`Unhandled corpus batch outcome: ${String(outcome)}`);
  }
};

while (true) {
  // Keyset by id so a row that fails to write (stays null) cannot stall
  // the scan; re-run the script later to retry the stragglers.
  const idFilter: SQL | undefined =
    lastId === null ? undefined : gt(caseLawDecisions.id, lastId);
  const where = idFilter
    ? and(eligibleForBackfill, idFilter)
    : eligibleForBackfill;

  // db-await-in-loop: keyset page per iteration; the page is the batch
  const rows: BackfillRow[] = await ingestionDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        country: caseLawDecisions.country,
        fulltext: caseLawDecisions.fulltext,
        sections: caseLawDecisions.sections,
        documentAst: caseLawDecisions.documentAst,
        contentHash: caseLawDecisions.contentHash,
        textS3Key: caseLawDecisions.textS3Key,
        normalizedS3Key: caseLawDecisions.normalizedS3Key,
        astS3Key: caseLawDecisions.astS3Key,
        updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
      })
      .from(caseLawDecisions)
      .where(where)
      .orderBy(asc(caseLawDecisions.id))
      .limit(BATCH_SIZE),
  );

  if (rows.length === 0) {
    break;
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    // One pack per chunk: the rows hand their payloads to one transfer
    // instead of three object PUTs each, and every row still settles under
    // its own fence once that pack is durable.
    const batch = openCorpusPackBatch({ scopedDb: ingestionDb });
    for (const row of chunk) {
      enqueueBackfillRow(batch, row);
    }
    const settled = await batch.flush();
    if (Result.isError(settled)) {
      // The batch never reached its per-decision outcomes, so nothing in it
      // was recorded.
      failed += chunk.length;
      captureError(settled.error, { step: "backfillCorpusStorage" });
      continue;
    }
    for (const [decisionId, outcome] of settled.value) {
      recordOutcome(decisionId, outcome);
    }
  }

  lastId = rows.at(-1)?.id ?? lastId;
  console.log(`  written=${written} skipped=${skipped} failed=${failed}`);
}

console.log(
  `Done. Wrote ${written} decisions, skipped ${skipped}, ${failed} failed.`,
);

// Non-zero on partial failure: the cutover checklist treats this run as
// green only when every decision has its corpus objects.
process.exit(failed === 0 ? 0 : 1);
