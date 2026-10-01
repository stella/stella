import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
/**
 * Complete older stored SK ÚS payloads from publisher search rows.
 * bun run src/scripts/complete-sk-us-raw.ts --checkpoint <path> [--dry-run|--apply] [--limit 200]
 * Checkpoints belong to one source and one operator; dry runs write nothing.
 */
import { open, readFile, rename } from "node:fs/promises";
import * as v from "valibot";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/handlers/case-law/ingestion/adapter";
import { fetchSkUsListing } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import { readStoredRawFromS3 } from "@/api/handlers/case-law/ingestion/pipeline/stored-raw";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { executedRows } from "@/api/lib/db/executed-rows";
import { errorTag } from "@/api/lib/errors/error-tag";
import {
  openRawSourceWriteWindow,
  RAW_SOURCE_FAMILY,
  writeSourceBinary,
  writeCaseLawRawPayload,
} from "@/api/lib/legal-search/raw-source-storage";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
} from "@/api/lib/safe-id-boundaries";
import {
  completeSkUsRawStatement,
  completedSkUsRawEnvelope,
  completeSkUsRawObservation,
  runSkUsRawPage,
  selectSkUsRawPageStatement,
  SK_US_RAW_OUTCOMES,
} from "@/api/scripts/complete-sk-us-raw-plan";
import type {
  SkUsRawCursor,
  SkUsRawOutcome,
} from "@/api/scripts/complete-sk-us-raw-plan";
import {
  flagInteger,
  readApplyFlag,
  rejectUnknownFlags,
  requiredFlagValue,
} from "@/api/scripts/repair-flags";

const USAGE =
  "complete-sk-us-raw.ts --checkpoint <path> [--dry-run|--apply] [--limit 200] [--page 200]";
rejectUnknownFlags({ known: ["checkpoint", "limit", "page"], usage: USAGE });
const apply = readApplyFlag(USAGE);
const limit = flagInteger({ name: "limit", fallback: 200, usage: USAGE });
const pageSize = flagInteger({ name: "page", fallback: 200, usage: USAGE });
const checkpointPath = requiredFlagValue({ name: "checkpoint", usage: USAGE });
const mode = apply ? "apply" : "dry-run";
const { rootDb, ingestionDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();
const execute = async (statement: SQLWrapper) =>
  await rootDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
    await tx.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
    return await tx.execute(statement);
  });
const sourceRows = v.parse(
  v.array(v.object({ id: v.pipe(v.string(), v.uuid()) })),
  executedRows(
    await execute(
      sql`SELECT id FROM case_law_sources WHERE adapter_key = ${ADAPTER_KEYS.SK_US}`,
    ),
  ),
);
const source = sourceRows.at(0);
if (source === undefined) {
  console.info("No sk-us source is registered.");
  process.exit(0);
}
const sourceId = brandPersistedCaseLawSourceId(source.id);
const cursorSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
});
const checkpointSchema = v.object({
  version: v.literal(1),
  sourceId: v.pipe(v.string(), v.uuid()),
  cursor: cursorSchema,
  outcome: v.picklist(SK_US_RAW_OUTCOMES),
});
const checkpointRead = await Result.tryPromise({
  try: async () => await readFile(checkpointPath, "utf-8"),
  catch: (cause) => cause,
});
let after: SkUsRawCursor | null = null;
if (Result.isOk(checkpointRead)) {
  const state = v.parse(checkpointSchema, JSON.parse(checkpointRead.value));
  if (state.sourceId !== sourceId) {
    panic("Checkpoint belongs to a different source");
  }
  if (
    state.outcome === "would_complete" ||
    state.outcome === "retry_later" ||
    state.outcome === "concurrent_write" ||
    state.outcome === "publisher_rate_limited"
  ) {
    panic("Checkpoint does not record a terminal applied outcome");
  }
  after = {
    id: brandPersistedCaseLawDecisionId(state.cursor.id),
    createdAt: state.cursor.createdAt,
  };
} else if (
  !(
    checkpointRead.error instanceof Error &&
    "code" in checkpointRead.error &&
    checkpointRead.error.code === "ENOENT"
  )
) {
  throw checkpointRead.error;
}

// The maintenance lane serializes checkpoint writers and releases on a crash.
const persistCheckpoint = async (
  cursor: SkUsRawCursor,
  outcome: SkUsRawOutcome,
) => {
  const state = { version: 1, sourceId, cursor, outcome };
  const journal = await open(`${checkpointPath}.outcomes.jsonl`, "a");
  await journal.write(`${JSON.stringify(state)}\n`);
  await journal.sync();
  await journal.close();
  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  const temporary = await open(temporaryPath, "w");
  await temporary.write(JSON.stringify(state));
  await temporary.sync();
  await temporary.close();
  await rename(temporaryPath, checkpointPath);
};

const rowSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  source_document_id: v.nullable(v.string()),
  case_number: v.string(),
  source_url: v.nullable(v.string()),
  source_raw_s3_key: v.nullable(v.string()),
  source_raw_content_type: v.nullable(v.string()),
});
const complete = async (
  cursor: SkUsRawCursor,
  operation: "apply" | "dry-run",
): Promise<SkUsRawOutcome> => {
  const window = openRawSourceWriteWindow();
  const rows = v.parse(
    v.array(rowSchema),
    executedRows(
      await execute(sql`
    SELECT id, source_document_id, case_number, source_url, source_raw_s3_key, source_raw_content_type
    FROM case_law_decisions WHERE id = ${cursor.id}::uuid AND source_id = ${sourceId}::uuid AND redacted_at IS NULL
  `),
    ),
  );
  const row = rows.at(0);
  if (row?.source_raw_s3_key === undefined || row.source_raw_s3_key === null) {
    return "raw_unavailable";
  }
  const oldKey = row.source_raw_s3_key;
  // Older identities were keyed by the publisher's download URL, not docket.
  const documentId =
    row.source_document_id ??
    /^https:\/\/www\.ustavnysud\.sk\/docDownload\/(?<id>[^/?#]+)$/u.exec(
      row.source_url ?? "",
    )?.groups?.["id"];
  if (documentId === undefined) {
    return "listing_identity_mismatch";
  }
  const raw = await readStoredRawFromS3(oldKey);
  const outcome = await completeSkUsRawObservation({
    raw,
    contentType: row.source_raw_content_type,
    documentId,
    caseNumber: row.case_number,
    fetchListing: async (identity) => await fetchSkUsListing(identity),
    mode: operation,
    writeCompletion: async (completion) => {
      const owner = {
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId,
        documentId: row.id,
      } as const;
      if (completion.file !== null) {
        const binary = await writeSourceBinary({
          ...owner,
          bytes: completion.file,
          contentType: "application/pdf",
          window,
        });
        if (Result.isError(binary)) {
          return "retry_later";
        }
        completion.objects = {
          ...completion.objects,
          "document-file": binary.value,
        };
      }
      const written = await writeCaseLawRawPayload({
        owner,
        window,
        data: completedSkUsRawEnvelope(completion),
        contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
        storedKey: oldKey,
        storedContentType: row.source_raw_content_type,
      });
      if (Result.isError(written)) {
        return "retry_later";
      }
      const changed = await ingestionDb(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
        await tx.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
        return executedRows(
          await tx.execute(
            completeSkUsRawStatement({
              sourceId,
              id: cursor.id,
              oldKey,
              oldContentType: row.source_raw_content_type,
              newKey: written.value,
            }),
          ),
        );
      });
      return changed.length === 1 ? "completed" : "concurrent_write";
    },
  });
  if (Result.isError(raw)) {
    console.info(
      JSON.stringify({ id: row.id, outcome, error: raw.error._tag }),
    );
  }
  return outcome;
};

// Select the invocation's bounded cursor list once; per-item work rereads the
// live pointer before its guarded write, and checkpoints still advance per item.
const selection = selectSkUsRawPageStatement({ sourceId, after, limit });
const explain = executedRows(await execute(sql`EXPLAIN ${selection}`));
const plan = v
  .parse(v.array(v.object({ "QUERY PLAN": v.string() })), explain)
  .map((row) => row["QUERY PLAN"])
  .join("\n");
if (
  plan.includes("Seq Scan") ||
  plan.includes("Sort") ||
  !plan.includes("Index Only Scan")
) {
  panic(`Selection requires an ordered index-only plan: ${plan}`);
}
const selected = v.parse(
  v.array(
    v.object({
      id: v.pipe(v.string(), v.uuid()),
      created_at: v.pipe(v.string(), v.isoTimestamp()),
    }),
  ),
  executedRows(await execute(selection)),
);
const counts: Record<string, number> = {};
let scanned = 0;
let stopped = false;
for (let offset = 0; offset < selected.length; offset += pageSize) {
  const page = selected.slice(offset, offset + pageSize);
  const result = await runSkUsRawPage({
    rows: page.map((row) => ({
      id: brandPersistedCaseLawDecisionId(row.id),
      createdAt: row.created_at,
    })),
    mode,
    complete: async (row, operation) => {
      const completed = await Result.tryPromise({
        try: async () => await complete(row, operation),
        catch: (cause) => cause,
      });
      if (Result.isOk(completed)) {
        return completed.value;
      }
      console.info(
        JSON.stringify({
          id: row.id,
          outcome: "retry_later",
          error: errorTag(completed.error),
        }),
      );
      return "retry_later";
    },
    checkpoint: persistCheckpoint,
  });
  for (const [outcome, count] of Object.entries(result.counts)) {
    counts[outcome] = (counts[outcome] ?? 0) + count;
    scanned += count;
  }
  after = result.cursor ?? after;
  if (result.stopped) {
    stopped = true;
    break;
  }
}
console.info(JSON.stringify({ mode, scanned, counts, cursor: after, stopped }));
process.exit(stopped ? 2 : 0);
