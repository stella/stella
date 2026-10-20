import { panic } from "better-result";
import type { Result } from "better-result";
import { inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { createSha256 } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions } from "@/api/db/schema";
import {
  CORPUS_SLICE_CONFIG,
  type CorpusSliceManifest,
} from "@/api/lib/case-law/corpus-slice";
import {
  type CorpusSliceImportResult,
  type CorpusSliceTransferError,
  type CorpusSliceTransferStorage,
  importStoredCorpusSlice,
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
  const seenSourceIds = new Set<string>();
  const objectKeys = new Set<string>();
  const memberHasher = createSha256();
  let memberCount = 0;
  const cells = new Map<string, CorpusSliceManifest["cells"][number]>();
  const decisionPredicate = slicePredicate(asOf, "t");

  const openShard = async (name: string) => {
    const key = `${prefix.replace(/\/$/u, "")}/${name}.ndjson`;
    const sink =
      storage.openWriter === undefined
        ? panic("corpus slice export storage requires a shard writer")
        : await storage.openWriter(key, "application/x-ndjson");
    const hasher = createSha256();
    let rows = 0;
    return {
      append: async (page: readonly TransferRow[]) => {
        if (page.length === 0) {
          return;
        }
        const text = `${rows === 0 ? "" : "\n"}${page
          .map((row) => JSON.stringify(row))
          .join("\n")}`;
        const bytes = new TextEncoder().encode(text);
        hasher.update(bytes);
        rows += page.length;
        await sink.write(bytes);
      },
      finish: async () => {
        await sink.close();
        return { name, rows, sha256: hasher.digest("hex") };
      },
    };
  };
  const writers = {
    sources: await openShard("sources"),
    decisions: await openShard("decisions"),
    supplements: await openShard("supplements"),
    citations: await openShard("citations"),
    objects: await openShard("objects"),
  };

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
    const [pageSupplements, pageCitations] = await Promise.all([
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
    // A supplement can belong to another source than its decision; both are
    // exported so a clean target can insert every row of the page.
    const sourceIds = [
      ...new Set(
        [...page, ...pageSupplements].map((row) =>
          v.parse(v.string(), field(row, "sourceId", "source_id")),
        ),
      ),
    ];
    const pageSources = await readRows(
      database,
      "sources",
      `t.id = ANY(${sqlUuidArray(sourceIds)})`,
      "t.id",
    );
    const newSources = pageSources.filter((source) => {
      const id = v.parse(v.string(), field(source, "id", "id"));
      if (seenSourceIds.has(id)) {
        return false;
      }
      seenSourceIds.add(id);
      return true;
    });
    await writers.sources.append(newSources);
    await writers.decisions.append(page);
    await writers.supplements.append(pageSupplements);
    await writers.citations.append(pageCitations);
    const sourceKeys = new Map(
      pageSources.map((row) => [
        v.parse(v.string(), field(row, "id", "id")),
        v.parse(v.string(), field(row, "adapterKey", "adapter_key")),
      ]),
    );
    for (const row of page) {
      const id = v.parse(v.string(), field(row, "id", "id"));
      memberHasher.update(`${memberCount === 0 ? "" : "\n"}${id}`);
      memberCount += 1;
      const sourceKey = v.parse(
        v.string(),
        sourceKeys.get(
          v.parse(v.string(), field(row, "sourceId", "source_id")),
        ),
      );
      const court = v.parse(v.string(), field(row, "court", "court"));
      const decisionDate = v.parse(
        v.nullable(v.string()),
        field(row, "decisionDate", "decision_date"),
      );
      const year =
        decisionDate === null
          ? { type: "undated" as const }
          : {
              type: "year" as const,
              year: Number.parseInt(decisionDate.slice(0, 4), 10),
            };
      const key = JSON.stringify([sourceKey, court, year]);
      const existing = cells.get(key);
      if (existing === undefined) {
        cells.set(key, { sourceKey, court, year, count: 1 });
      } else {
        existing.count += 1;
      }
    }
    for (const row of [...page, ...pageSupplements]) {
      for (const name of [
        "sourceRawS3Key",
        "textS3Key",
        "normalizedS3Key",
        "astS3Key",
      ]) {
        const snake = name.replaceAll(
          /[A-Z]/gu,
          (letter) => `_${letter.toLowerCase()}`,
        );
        const key = row[name] ?? row[snake];
        if (typeof key === "string") {
          objectKeys.add(key);
        }
      }
    }
    await readDecisionPage(ids.at(-1) ?? panic("decision page was empty"));
  };

  await readDecisionPage(null);
  await writers.objects.append(
    [...objectKeys].toSorted().map((key) => ({ key })),
  );
  const shards = await Promise.all(
    Object.values(writers).map(async (writer) => await writer.finish()),
  );
  const manifest: CorpusSliceManifest = {
    version: 1,
    asOf: asOf.toISOString(),
    recentYears: CORPUS_SLICE_CONFIG.recentYears,
    memberCount,
    memberIdsSha256: memberHasher.digest("hex"),
    cells: [...cells.values()].toSorted((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      if (leftKey === rightKey) {
        return 0;
      }
      return leftKey < rightKey ? -1 : 1;
    }),
  };
  await storage.write(
    `${prefix.replace(/\/$/u, "")}/manifest.json`,
    new TextEncoder().encode(JSON.stringify({ corpus: manifest, shards })),
    "application/json",
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
  reconcileDependents: async (
    ids: ReadonlySet<unknown>,
    supplements: readonly TransferRow[],
    citations: readonly TransferRow[],
  ) =>
    await ingestionDatabase(async (tx) => {
      const retained = [...ids].map((id) => v.parse(v.string(), id));
      if (retained.length === 0) {
        return { changed: 0, projectionsEnqueued: 0 };
      }
      const retainedSql = sqlUuidArray(retained);
      const supplementRows = sqlString(JSON.stringify(supplements));
      const citationRows = sqlString(JSON.stringify(citations));
      const removedSupplements = rowsOf(
        await tx.execute(
          sql.raw(
            `DELETE FROM case_law_decision_supplements current WHERE current.decision_id = ANY(${retainedSql}) AND NOT EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::case_law_decision_supplements, ${supplementRows}::text::jsonb) desired WHERE desired.source_id = current.source_id AND desired.source_document_id = current.source_document_id AND desired.kind = current.kind) RETURNING 1`,
          ),
        ),
      );
      const removedCitations = rowsOf(
        await tx.execute(
          sql.raw(
            `DELETE FROM case_law_citations current WHERE current.citing_decision_id = ANY(${retainedSql}) AND NOT EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::case_law_citations, ${citationRows}::text::jsonb) desired WHERE desired.id = current.id) RETURNING 1`,
          ),
        ),
      );
      await reconcileProjectionSubjects({
        tx,
        subjects: retained.map((id) => ({
          family: "case_law",
          entityId: brandPersistedCaseLawDecisionId(id),
        })),
        reconcile: reconcileProjection,
      });
      return {
        changed: removedSupplements.length + removedCitations.length,
        projectionsEnqueued: retained.length,
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
