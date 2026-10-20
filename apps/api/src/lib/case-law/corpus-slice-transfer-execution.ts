import { TaggedError } from "better-result";
import type { Result } from "better-result";
import * as v from "valibot";

import {
  corpusSliceManifest,
  isInCorpusSlice,
} from "@/api/lib/case-law/corpus-slice";
import {
  buildCorpusSliceExport,
  type CorpusSliceImportResult,
  type CorpusSliceTransferError,
  type CorpusSliceTransferStorage,
  importStoredCorpusSlice,
  writeCorpusSliceExport,
} from "@/api/lib/case-law/corpus-slice-transfer";
import type {
  CaseLawIngestionHandle,
  CaseLawRootHandle,
} from "@/api/lib/case-law/maintenance-lane";
import { reconcileCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

const TABLES = {
  sources: "case_law_sources",
  decisions: "case_law_decisions",
  supplements: "case_law_decision_supplements",
  citations: "case_law_citations",
} as const;

type TransferTable = keyof typeof TABLES;
type TransferRow = Readonly<Record<string, unknown>>;

const rowEnvelopeSchema = v.strictObject({ row: v.string() });

const readTable = async (
  database: CaseLawRootHandle,
  table: TransferTable,
  batchSize: number,
): Promise<TransferRow[]> => {
  const rows: TransferRow[] = [];
  let offset = 0;
  while (true) {
    const relation =
      table === "decisions"
        ? "(SELECT d.*, s.adapter_key AS source_key FROM case_law_decisions d JOIN case_law_sources s ON s.id = d.source_id)"
        : TABLES[table];
    const page = await database.execute<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM ${relation} t ORDER BY 1 LIMIT ${batchSize} OFFSET ${offset}`,
    );
    for (const envelope of page) {
      const parsedEnvelope = v.parse(rowEnvelopeSchema, envelope);
      rows.push(
        v.parse(
          v.record(v.string(), v.unknown()),
          JSON.parse(parsedEnvelope.row),
        ),
      );
    }
    if (page.length < batchSize) {
      return rows;
    }
    offset += page.length;
  }
};

const field = (row: TransferRow, camel: string, snake: string): unknown =>
  row[camel] ?? row[snake];

type ExportExecutionOptions = {
  database: CaseLawRootHandle;
  storage: CorpusSliceTransferStorage;
  prefix: string;
  asOf: Date;
  batchSize: number;
};

export const exportCorpusSliceFromDatabase = async ({
  database,
  storage,
  prefix,
  asOf,
  batchSize,
}: ExportExecutionOptions): Promise<void> => {
  const [sources, allDecisions, supplements, citations] = await Promise.all([
    readTable(database, "sources", batchSize),
    readTable(database, "decisions", batchSize),
    readTable(database, "supplements", batchSize),
    readTable(database, "citations", batchSize),
  ]);
  const censusRows = allDecisions.map((row) => ({
    id: brandPersistedCaseLawDecisionId(
      v.parse(v.string(), field(row, "id", "id")),
    ),
    sourceKey: v.parse(v.string(), field(row, "sourceKey", "source_key")),
    court: v.parse(v.string(), field(row, "court", "court")),
    decisionDate: v.parse(
      v.nullable(v.string()),
      field(row, "decisionDate", "decision_date"),
    ),
  }));
  const manifest = corpusSliceManifest(censusRows, asOf);
  const memberIds = new Set(
    censusRows
      .filter((row) => isInCorpusSlice(row, { asOf }))
      .map(({ id }) => id),
  );
  const decisions = allDecisions.filter((row) =>
    memberIds.has(
      brandPersistedCaseLawDecisionId(
        v.parse(v.string(), field(row, "id", "id")),
      ),
    ),
  );
  await writeCorpusSliceExport(
    prefix,
    buildCorpusSliceExport({
      manifest,
      sources,
      decisions,
      supplements,
      citations,
    }),
    storage,
  );
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;
class CorpusSliceExecutionError extends TaggedError(
  "CorpusSliceExecutionError",
)<{ message: string }> {}

const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new CorpusSliceExecutionError({
      message: "invalid corpus transfer column",
    });
  }
  return `"${value}"`;
};

const importStore = (
  database: CaseLawRootHandle,
  ingestionDatabase: CaseLawIngestionHandle,
) => ({
  upsert: async (table: TransferTable, rows: readonly TransferRow[]) => {
    if (rows.length === 0) {
      return 0;
    }
    const columns = Object.keys(rows[0] ?? {}).map(identifier);
    const conflicts =
      table === "supplements"
        ? ["source_id", "source_document_id", "kind"]
        : ["id"];
    const updates = columns.filter(
      (column) => !conflicts.map(identifier).includes(column),
    );
    const name = TABLES[table];
    const query = `INSERT INTO ${name} SELECT p.* FROM jsonb_populate_recordset(NULL::${name}, ${sqlString(JSON.stringify(rows))}::text::jsonb) p ON CONFLICT (${conflicts.map(identifier).join(",")}) DO UPDATE SET ${updates.map((column) => `${column}=EXCLUDED.${column}`).join(",")} WHERE to_jsonb(${name}) IS DISTINCT FROM to_jsonb(EXCLUDED) RETURNING 1`;
    const changed = await database.execute(query);
    return changed.length;
  },
  removeDecisionsExcept: async (ids: ReadonlySet<unknown>) => {
    const values = [...ids]
      .map((id) => sqlString(v.parse(v.string(), id)))
      .join(",");
    const query =
      values.length === 0
        ? "DELETE FROM case_law_decisions RETURNING 1"
        : `DELETE FROM case_law_decisions WHERE id NOT IN (${values}) RETURNING 1`;
    const removed = await database.execute(query);
    return removed.length;
  },
  enqueueProjectionDesiredState: async (ids: ReadonlySet<unknown>) =>
    await ingestionDatabase(async (tx) => {
      for (const id of ids) {
        await reconcileCorpusProjectionDesiredStateTx(tx, {
          family: "case_law",
          entityId: brandPersistedCaseLawDecisionId(v.parse(v.string(), id)),
        });
      }
      return ids.size;
    }),
});

export const importCorpusSliceIntoDatabase = async (
  prefix: string,
  storage: CorpusSliceTransferStorage,
  database: CaseLawRootHandle,
  ingestionDatabase: CaseLawIngestionHandle,
): Promise<Result<CorpusSliceImportResult, CorpusSliceTransferError>> =>
  await importStoredCorpusSlice(
    prefix,
    storage,
    importStore(database, ingestionDatabase),
  );
