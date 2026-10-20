import { panic } from "better-result";
import type { Result } from "better-result";
import { inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import {
  CORPUS_SLICE_CONFIG,
  corpusSliceManifest,
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

const parseRows = (page: readonly { row: string }[]): TransferRow[] =>
  page.map((envelope) => {
    const parsedEnvelope = v.parse(rowEnvelopeSchema, envelope);
    return v.parse(
      v.record(v.string(), v.unknown()),
      JSON.parse(parsedEnvelope.row),
    );
  });

const readRows = async (
  database: CaseLawRootHandle,
  table: TransferTable,
  predicate: string,
  orderBy: string,
): Promise<TransferRow[]> => {
  const relation = TABLES[table];
  return parseRows(
    await database.execute<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM ${relation} t WHERE ${predicate} ORDER BY ${orderBy}`,
    ),
  );
};

const field = (row: TransferRow, camel: string, snake: string): unknown =>
  row[camel] ?? row[snake];

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlUuidArray = (values: readonly string[]): string =>
  `ARRAY[${values.map(sqlString).join(",")}]::uuid[]`;

const slicePredicate = (asOf: Date, alias: string): string => {
  const asOfDay = Temporal.Instant.fromEpochMilliseconds(asOf.getTime())
    .toZonedDateTimeISO("UTC")
    .toPlainDate();
  const year = asOfDay.year - CORPUS_SLICE_CONFIG.recentYears + 1;
  const start = `${String(year).padStart(4, "0")}-01-01`;
  const end = asOfDay.toString();
  const pinned = sqlUuidArray(CORPUS_SLICE_CONFIG.pinnedDecisionIds);
  return `((${alias}.decision_date >= ${sqlString(start)} AND ${alias}.decision_date <= ${sqlString(end)}) OR ${alias}.id = ANY(${pinned}))`;
};

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
  const sourcesById = new Map<string, TransferRow>();
  const decisions: TransferRow[] = [];
  const supplements: TransferRow[] = [];
  const citations: TransferRow[] = [];
  const decisionPredicate = slicePredicate(asOf, "t");

  const readDecisionPage = async (lastId: string | null): Promise<void> => {
    const cursor = lastId === null ? "" : ` AND t.id > ${sqlString(lastId)}`;
    const page = parseRows(
      await database.execute<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM case_law_decisions t WHERE ${decisionPredicate}${cursor} ORDER BY t.id LIMIT ${batchSize}`,
      ),
    );
    if (page.length === 0) {
      return;
    }
    const ids = page.map((row) => v.parse(v.string(), field(row, "id", "id")));
    const sourceIds = [
      ...new Set(
        page.map((row) =>
          v.parse(v.string(), field(row, "sourceId", "source_id")),
        ),
      ),
    ];
    const [pageSources, pageSupplements, pageCitations] = await Promise.all([
      readRows(
        database,
        "sources",
        `t.id = ANY(${sqlUuidArray(sourceIds)})`,
        "t.id",
      ),
      readRows(
        database,
        "supplements",
        `t.decision_id = ANY(${sqlUuidArray(ids)})`,
        "t.decision_id, t.source_id, t.source_document_id",
      ),
      readRows(
        database,
        "citations",
        `t.citing_decision_id = ANY(${sqlUuidArray(ids)}) AND t.cited_decision_id IN (SELECT d.id FROM case_law_decisions d WHERE ${slicePredicate(asOf, "d")})`,
        "t.citing_decision_id, t.id",
      ),
    ]);
    for (const source of pageSources) {
      sourcesById.set(v.parse(v.string(), field(source, "id", "id")), source);
    }
    decisions.push(...page);
    supplements.push(...pageSupplements);
    citations.push(...pageCitations);
    await readDecisionPage(ids.at(-1) ?? panic("decision page was empty"));
  };

  await readDecisionPage(null);
  const sources = [...sourcesById.values()].toSorted((left, right) => {
    const leftId = v.parse(v.string(), field(left, "id", "id"));
    const rightId = v.parse(v.string(), field(right, "id", "id"));
    if (leftId === rightId) {
      return 0;
    }
    return leftId < rightId ? -1 : 1;
  });
  const sourceKeys = new Map(
    sources.map((row) => [
      v.parse(v.string(), field(row, "id", "id")),
      v.parse(v.string(), field(row, "adapterKey", "adapter_key")),
    ]),
  );
  const censusRows = decisions.map((row) => ({
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

const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    return panic("invalid corpus transfer column");
  }
  return `"${value}"`;
};

const rowsOf = <Row>(
  result: readonly Row[] | { rows: readonly Row[] },
): readonly Row[] => ("rows" in result ? result.rows : result);

type ProjectionReconciler = (
  tx: Transaction,
  subject: {
    family: "case_law";
    entityId: ReturnType<typeof brandPersistedCaseLawDecisionId>;
  },
) => Promise<unknown>;

type ProjectionSubject = Parameters<ProjectionReconciler>[1];

type ReconcileProjectionSubjectsOptions = {
  tx: Transaction;
  subjects: readonly ProjectionSubject[];
  reconcile: ProjectionReconciler;
  retire?: ProjectionReconciler;
  index?: number;
};

const reconcileProjectionSubjects = async ({
  tx,
  subjects,
  reconcile,
  retire,
  index = 0,
}: ReconcileProjectionSubjectsOptions): Promise<void> => {
  const subject = subjects.at(index);
  if (subject === undefined) {
    return;
  }
  await reconcile(tx, subject);
  if (retire !== undefined) {
    await retire(tx, subject);
  }
  const next = { tx, subjects, reconcile, index: index + 1 };
  await reconcileProjectionSubjects(
    retire === undefined ? next : { ...next, retire },
  );
};

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
      await reconcileProjectionSubjects({
        tx,
        subjects: existingProjectionIds.map(({ id }) => ({
          family: "case_law",
          entityId: id,
        })),
        reconcile: reconcileProjection,
      });
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
      await reconcileProjectionSubjects({
        tx,
        subjects: removed.map(({ id }) => ({
          family: "case_law",
          entityId: brandPersistedCaseLawDecisionId(id),
        })),
        reconcile: reconcileProjection,
        retire: retireProjection,
      });
      if (removed.length > 0) {
        const removedValues = removed.map(({ id }) => sqlString(id)).join(",");
        await tx.execute(
          sql.raw(
            `DELETE FROM case_law_decisions WHERE id IN (${removedValues})`,
          ),
        );
      }
      await reconcileProjectionSubjects({
        tx,
        subjects: [...ids].map((id) => ({
          family: "case_law",
          entityId: brandPersistedCaseLawDecisionId(v.parse(v.string(), id)),
        })),
        reconcile: reconcileProjection,
      });
      return {
        removedIds: removed.map(({ id }) => id),
        projectionsEnqueued: ids.size + removed.length,
      };
    }),
});

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
