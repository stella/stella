import { panic } from "better-result";
import * as v from "valibot";

import { createSha256 } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import {
  CORPUS_SLICE_CONFIG,
  type CorpusSliceManifest,
} from "@/api/lib/case-law/corpus-slice";
import type { CorpusSliceTransferStorage } from "@/api/lib/case-law/corpus-slice-transfer";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";

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

export const CORPUS_SLICE_SNAPSHOT_ISOLATION =
  "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ";

type CorpusSliceExportResult = { manifestKey: string };

type ExportExecutionOptions = {
  database: CaseLawRootHandle;
  storage: CorpusSliceTransferStorage;
  prefix: string;
  asOf: Date;
  batchSize: number;
};

const executeCorpusSliceExport = async ({
  database,
  storage,
  prefix,
  asOf,
  batchSize,
}: ExportExecutionOptions): Promise<CorpusSliceExportResult> => {
  // Every export owns a fresh, time-ordered directory: a rerun or a failed
  // run can never rewrite shards that an earlier manifest already describes.
  const generation = `${prefix.replace(/\/$/u, "")}/generations/${Bun.randomUUIDv7()}`;
  const seenSourceIds = new Set<string>();
  const objectKeys = new Set<string>();
  const memberHasher = createSha256();
  let memberCount = 0;
  const cells = new Map<string, CorpusSliceManifest["cells"][number]>();
  const decisionPredicate = slicePredicate(asOf, "t");

  const openShard = async (name: string) => {
    const sink = await storage.openWriter(
      `${generation}/${name}.ndjson`,
      "application/x-ndjson",
    );
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
        `SELECT row_to_json(t)::text AS row FROM case_law_published_decisions t WHERE ${decisionPredicate}${cursor} ORDER BY t.id LIMIT ${batchSize}`,
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
        `t.citing_decision_id = ANY(${sqlUuidArray(ids)}) AND t.cited_decision_id IN (SELECT d.id FROM case_law_published_decisions d WHERE ${slicePredicate(asOf, "d")})`,
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
  const manifestKey = `${generation}/manifest.json`;
  await storage.write(
    manifestKey,
    new TextEncoder().encode(JSON.stringify({ corpus: manifest, shards })),
    "application/json",
  );
  return { manifestKey };
};

/** Streams every shard from one read-only, repeatable snapshot. */
export const exportCorpusSliceFromDatabase = async (
  options: ExportExecutionOptions,
): Promise<CorpusSliceExportResult> =>
  await withAggregateTransaction(options.database, async (tx) => {
    await tx.execute(CORPUS_SLICE_SNAPSHOT_ISOLATION);
    return await executeCorpusSliceExport({
      ...options,
      database: {
        execute: async (query) => await tx.execute(query),
        transaction: options.database.transaction,
      },
    });
  });
