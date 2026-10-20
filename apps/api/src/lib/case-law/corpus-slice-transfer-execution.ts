import { panic } from "better-result";
import type { Result } from "better-result";
import { inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
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
    const relation = TABLES[table];
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
  const sourceKeys = new Map(
    sources.map((row) => [
      v.parse(v.string(), field(row, "id", "id")),
      v.parse(v.string(), field(row, "adapterKey", "adapter_key")),
    ]),
  );
  const censusRows = allDecisions.map((row) => ({
    id: brandPersistedCaseLawDecisionId(
      v.parse(v.string(), field(row, "id", "id")),
    ),
    sourceKey: v.parse(
      v.string(),
      sourceKeys.get(v.parse(v.string(), field(row, "sourceId", "source_id"))),
    ),
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
const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    return panic("invalid corpus transfer column");
  }
  return `"${value}"`;
};

const rowsOf = <Row>(
  result: readonly Row[] | { rows: readonly Row[] },
): readonly Row[] => ("rows" in result ? result.rows : result);

const importStore = (
  ingestionDatabase: CaseLawIngestionHandle,
  reconcileProjection: ProjectionReconciler,
  retireProjection: ProjectionReconciler,
) => ({
  upsertAndRecordProjectionDesiredState: async (
    table: TransferTable,
    rows: readonly TransferRow[],
    projectionIds: ReadonlySet<unknown>,
  ) =>
    await ingestionDatabase(async (tx) => {
      const columns = Object.keys(rows[0] ?? {}).map(identifier);
      const conflicts =
        table === "supplements"
          ? ["source_id", "source_document_id", "kind"]
          : ["id"];
      const ownerManagedColumnNames =
        table === "decisions" ? ["projection_epoch", "updated_at"] : [];
      const ownerManagedColumns = ownerManagedColumnNames.map(identifier);
      const updates = columns.filter(
        (column) =>
          !conflicts.map(identifier).includes(column) &&
          !ownerManagedColumns.includes(column),
      );
      const name = TABLES[table];
      const comparableRow = (row: string) =>
        ownerManagedColumns.length === 0
          ? `to_jsonb(${row})`
          : `to_jsonb(${row}) - ${ownerManagedColumnNames.map(sqlString).join(" - ")}`;
      const query = `INSERT INTO ${name} SELECT p.* FROM jsonb_populate_recordset(NULL::${name}, ${sqlString(JSON.stringify(rows))}::text::jsonb) p ON CONFLICT (${conflicts.map(identifier).join(",")}) DO UPDATE SET ${updates.map((column) => `${column}=EXCLUDED.${column}`).join(",")} WHERE ${comparableRow(name)} IS DISTINCT FROM ${comparableRow("EXCLUDED")} RETURNING 1`;
      const changed = rowsOf(await tx.execute(sql.raw(query)));
      const parsedProjectionIds = [...projectionIds].map((id) =>
        brandPersistedCaseLawDecisionId(v.parse(v.string(), id)),
      );
      const existingProjectionIds =
        parsedProjectionIds.length === 0
          ? []
          : await tx
              .select({ id: caseLawDecisions.id })
              .from(caseLawDecisions)
              .where(inArray(caseLawDecisions.id, parsedProjectionIds));
      for (const { id } of existingProjectionIds) {
        await reconcileProjection(tx, {
          family: "case_law",
          entityId: id,
        });
      }
      return {
        changed: changed.length,
        projectionsEnqueued: existingProjectionIds.length,
      };
    }),
  removeDecisionsExceptAndRecordProjectionDesiredState: async (
    ids: ReadonlySet<unknown>,
  ) =>
    await ingestionDatabase(async (tx) => {
      const values = [...ids]
        .map((id) => sqlString(v.parse(v.string(), id)))
        .join(",");
      const predicate =
        values.length === 0 ? "" : ` WHERE id NOT IN (${values})`;
      const removed = rowsOf(
        await tx.execute<{ id: string }>(
          sql.raw(`SELECT id FROM case_law_decisions${predicate}`),
        ),
      );
      for (const { id } of removed) {
        await reconcileProjection(tx, {
          family: "case_law",
          entityId: brandPersistedCaseLawDecisionId(id),
        });
        await retireProjection(tx, {
          family: "case_law",
          entityId: brandPersistedCaseLawDecisionId(id),
        });
      }
      if (removed.length > 0) {
        const removedValues = removed.map(({ id }) => sqlString(id)).join(",");
        await tx.execute(
          sql.raw(
            `DELETE FROM case_law_decisions WHERE id IN (${removedValues})`,
          ),
        );
      }
      for (const id of ids) {
        await reconcileProjection(tx, {
          family: "case_law",
          entityId: brandPersistedCaseLawDecisionId(v.parse(v.string(), id)),
        });
      }
      return {
        removedIds: removed.map(({ id }) => id),
        projectionsEnqueued: ids.size + removed.length,
      };
    }),
});

type ProjectionReconciler = (
  tx: Transaction,
  subject: {
    family: "case_law";
    entityId: ReturnType<typeof brandPersistedCaseLawDecisionId>;
  },
) => Promise<unknown>;

const reconcileProjection: ProjectionReconciler = async (tx, subject) => {
  const { reconcileCorpusProjectionDesiredStateTx } =
    await import("@/api/lib/legal-search/corpus-index-projection-desired-state");
  return await reconcileCorpusProjectionDesiredStateTx(tx, subject);
};

const retireProjection: ProjectionReconciler = async (tx, subject) => {
  const { retireCorpusProjectionDesiredStateTx } =
    await import("@/api/lib/legal-search/corpus-index-projection-desired-state");
  return await retireCorpusProjectionDesiredStateTx(tx, subject);
};

type ImportExecutionOptions = {
  prefix: string;
  storage: CorpusSliceTransferStorage;
  ingestionDatabase: CaseLawIngestionHandle;
  reconcileProjection?: ProjectionReconciler;
  retireProjection?: ProjectionReconciler;
};

export const importCorpusSliceIntoDatabase = async ({
  prefix,
  storage,
  ingestionDatabase,
  reconcileProjection: reconcile = reconcileProjection,
  retireProjection: retire = retireProjection,
}: ImportExecutionOptions): Promise<
  Result<CorpusSliceImportResult, CorpusSliceTransferError>
> =>
  await importStoredCorpusSlice(
    prefix,
    storage,
    importStore(ingestionDatabase, reconcile, retire),
  );
