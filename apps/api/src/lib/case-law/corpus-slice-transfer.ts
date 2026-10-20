import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import {
  parseCorpusSliceManifest,
  type CorpusSliceManifest,
} from "@/api/lib/case-law/corpus-slice";

export const CORPUS_SLICE_EXPORT_TABLES = [
  "case_law_sources",
  "case_law_decisions",
  "case_law_decision_supplements",
  "case_law_citations",
] as const;

const REQUIRED_SHARDS = [
  "sources",
  "decisions",
  "supplements",
  "citations",
  "objects",
] as const;

type CorpusSliceTransferRow = Readonly<Record<string, unknown>>;

type CorpusSliceShardName =
  | "sources"
  | "decisions"
  | "supplements"
  | "citations"
  | "objects";

export type CorpusSliceShard = {
  name: CorpusSliceShardName;
  ndjson: string;
  sha256: string;
  rows: number;
};

export type CorpusSliceTransferManifest = {
  corpus: CorpusSliceManifest;
  shards: readonly Pick<CorpusSliceShard, "name" | "rows" | "sha256">[];
};

export class CorpusSliceTransferError extends TaggedError(
  "CorpusSliceTransferError",
)<{ message: string }> {}

const jsonValue = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  return value;
};

const encodeShard = (
  name: CorpusSliceShardName,
  rows: readonly CorpusSliceTransferRow[],
): CorpusSliceShard => {
  const ndjson = rows.map((row) => JSON.stringify(row, jsonValue)).join("\n");
  return { name, ndjson, sha256: sha256Hex(ndjson), rows: rows.length };
};

type BuildExportOptions = {
  manifest: CorpusSliceManifest;
  sources: readonly CorpusSliceTransferRow[];
  decisions: readonly CorpusSliceTransferRow[];
  supplements: readonly CorpusSliceTransferRow[];
  citations: readonly CorpusSliceTransferRow[];
};

/** Pure export plan. Database and object-storage adapters only execute this plan. */
export const buildCorpusSliceExport = ({
  manifest,
  sources,
  decisions,
  supplements,
  citations,
}: BuildExportOptions): {
  manifest: CorpusSliceTransferManifest;
  shards: readonly CorpusSliceShard[];
} => {
  const ids = new Set(decisions.map((row) => row["id"]));
  const includedSources = new Set(
    decisions.map((row) => row["sourceId"] ?? row["source_id"]),
  );
  const objectKeys = new Set<string>();
  const includedSupplements = supplements.filter((row) =>
    ids.has(row["decisionId"] ?? row["decision_id"]),
  );
  for (const row of [...decisions, ...includedSupplements]) {
    for (const field of [
      "sourceRawS3Key",
      "textS3Key",
      "normalizedS3Key",
      "astS3Key",
    ]) {
      const snakeField = field.replaceAll(
        /[A-Z]/gu,
        (letter) => `_${letter.toLowerCase()}`,
      );
      const key = row[field] ?? row[snakeField];
      if (typeof key === "string") {
        objectKeys.add(key);
      }
    }
  }
  const shards = [
    encodeShard(
      "sources",
      sources.filter((row) => includedSources.has(row["id"])),
    ),
    encodeShard("decisions", decisions),
    encodeShard("supplements", includedSupplements),
    encodeShard(
      "citations",
      citations.filter(
        (row) =>
          ids.has(row["citingDecisionId"] ?? row["citing_decision_id"]) &&
          ids.has(row["citedDecisionId"] ?? row["cited_decision_id"]),
      ),
    ),
    encodeShard(
      "objects",
      [...objectKeys].toSorted().map((key) => ({ key })),
    ),
  ];
  return {
    manifest: {
      corpus: manifest,
      shards: shards.map(({ name, rows, sha256 }) => ({ name, rows, sha256 })),
    },
    shards,
  };
};

const reviveValue = (_key: string, value: unknown): unknown => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if ("$date" in value && typeof value.$date === "string") {
    return new Date(value.$date);
  }
  if ("$bigint" in value && typeof value.$bigint === "string") {
    return BigInt(value.$bigint);
  }
  return value;
};

const verifyCorpusSliceShards = (
  manifest: CorpusSliceTransferManifest,
  shards: readonly CorpusSliceShard[],
): Result<
  ReadonlyMap<CorpusSliceShardName, readonly CorpusSliceTransferRow[]>,
  CorpusSliceTransferError
> => {
  const manifestNames = manifest.shards.map(({ name }) => name);
  const suppliedNames = shards.map(({ name }) => name);
  for (const required of REQUIRED_SHARDS) {
    if (
      manifestNames.filter((name) => name === required).length !== 1 ||
      suppliedNames.filter((name) => name === required).length !== 1
    ) {
      return Result.err(
        new CorpusSliceTransferError({
          message: `corpus slice required shard is missing or duplicated: ${required}`,
        }),
      );
    }
  }
  const parsed = new Map<
    CorpusSliceShardName,
    readonly CorpusSliceTransferRow[]
  >();
  for (const expected of manifest.shards) {
    const shard = shards.find(({ name }) => name === expected.name);
    if (
      shard === undefined ||
      sha256Hex(shard.ndjson) !== expected.sha256 ||
      shard.rows !== expected.rows
    ) {
      return Result.err(
        new CorpusSliceTransferError({
          message: `corpus slice shard digest mismatch: ${expected.name}`,
        }),
      );
    }
    const rows: CorpusSliceTransferRow[] = [];
    for (const line of shard.ndjson.split("\n")) {
      if (line.length > 0) {
        const value: unknown = JSON.parse(line, reviveValue);
        const record = v.safeParse(v.record(v.string(), v.unknown()), value);
        if (!record.success) {
          return Result.err(
            new CorpusSliceTransferError({
              message: `corpus slice shard row is not an object: ${expected.name}`,
            }),
          );
        }
        rows.push(record.output);
      }
    }
    if (rows.length !== expected.rows) {
      return Result.err(
        new CorpusSliceTransferError({
          message: `corpus slice shard row count mismatch: ${expected.name}`,
        }),
      );
    }
    parsed.set(expected.name, rows);
  }
  return Result.ok(parsed);
};

export type CorpusSliceTransferStorage = {
  read: (key: string) => Promise<Uint8Array | null>;
  write: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  openWriter?: (
    key: string,
    contentType: string,
  ) => Promise<{
    write: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const objectKey = (prefix: string, name: string): string =>
  `${prefix.replace(/\/$/u, "")}/${name}`;

/** Writes all data shards before publishing the manifest that makes them visible. */
export const writeCorpusSliceExport = async (
  prefix: string,
  exported: ReturnType<typeof buildCorpusSliceExport>,
  storage: CorpusSliceTransferStorage,
): Promise<void> => {
  for (const shard of exported.shards) {
    await storage.write(
      objectKey(prefix, `${shard.name}.ndjson`),
      encoder.encode(shard.ndjson),
      "application/x-ndjson",
    );
  }
  await storage.write(
    objectKey(prefix, "manifest.json"),
    encoder.encode(JSON.stringify(exported.manifest)),
    "application/json",
  );
};

const transferManifestSchema = v.strictObject({
  corpus: v.unknown(),
  shards: v.array(
    v.strictObject({
      name: v.picklist([
        "sources",
        "decisions",
        "supplements",
        "citations",
        "objects",
      ]),
      rows: v.pipe(v.number(), v.integer(), v.minValue(0)),
      sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
    }),
  ),
});

export const parseCorpusSliceTransferManifest = (
  value: unknown,
): Result<CorpusSliceTransferManifest, CorpusSliceTransferError> => {
  const parsed = v.safeParse(transferManifestSchema, value);
  if (!parsed.success) {
    return Result.err(
      new CorpusSliceTransferError({
        message: "corpus slice manifest is invalid",
      }),
    );
  }
  const corpus = parseCorpusSliceManifest(parsed.output.corpus);
  if (Result.isError(corpus)) {
    return Result.err(
      new CorpusSliceTransferError({ message: corpus.error.message }),
    );
  }
  return Result.ok({ corpus: corpus.value, shards: parsed.output.shards });
};

/** Loads every shard into an immutable verification set; callers verify before writing. */
const readCorpusSliceExport = async (
  prefix: string,
  storage: CorpusSliceTransferStorage,
): Promise<
  Result<
    { manifest: CorpusSliceTransferManifest; shards: CorpusSliceShard[] },
    CorpusSliceTransferError
  >
> => {
  const manifestBytes = await storage.read(objectKey(prefix, "manifest.json"));
  if (manifestBytes === null) {
    return Result.err(
      new CorpusSliceTransferError({
        message: "corpus slice manifest is missing",
      }),
    );
  }
  const decoded: unknown = JSON.parse(decoder.decode(manifestBytes));
  const parsed = parseCorpusSliceTransferManifest(decoded);
  if (Result.isError(parsed)) {
    return Result.err(parsed.error);
  }
  const manifest = parsed.value;
  const shards: CorpusSliceShard[] = [];
  for (const expected of manifest.shards) {
    const bytes = await storage.read(
      objectKey(prefix, `${expected.name}.ndjson`),
    );
    if (bytes === null) {
      return Result.err(
        new CorpusSliceTransferError({
          message: `corpus slice shard is missing: ${expected.name}`,
        }),
      );
    }
    shards.push({ ...expected, ndjson: decoder.decode(bytes) });
  }
  const verified = verifyCorpusSliceShards(manifest, shards);
  if (Result.isError(verified)) {
    return Result.err(verified.error);
  }
  return Result.ok({ manifest, shards });
};

export const importStoredCorpusSlice = async (
  prefix: string,
  storage: CorpusSliceTransferStorage,
  store: ImportStore,
): Promise<Result<CorpusSliceImportResult, CorpusSliceTransferError>> => {
  const exported = await readCorpusSliceExport(prefix, storage);
  if (Result.isError(exported)) {
    return Result.err(exported.error);
  }
  return await importCorpusSlice(
    exported.value.manifest,
    exported.value.shards,
    store,
  );
};

type ImportStore = {
  upsertAndRecordProjectionDesiredState: (
    table: Exclude<CorpusSliceShardName, "objects">,
    rows: readonly CorpusSliceTransferRow[],
    projectionIds: ReadonlySet<unknown>,
  ) => Promise<{ changed: number; projectionsEnqueued: number }>;
  removeDecisionsExceptAndRecordProjectionDesiredState: (
    ids: ReadonlySet<unknown>,
  ) => Promise<{
    removedIds: readonly unknown[];
    projectionsEnqueued: number;
  }>;
  reconcileDependents: (
    ids: ReadonlySet<unknown>,
    supplements: readonly CorpusSliceTransferRow[],
    citations: readonly CorpusSliceTransferRow[],
  ) => Promise<{ changed: number; projectionsEnqueued: number }>;
};

const IMPORT_BATCH_SIZE = 500;

const projectionIdsForBatch = (
  table: Exclude<CorpusSliceShardName, "objects">,
  rows: readonly CorpusSliceTransferRow[],
  sliceIds: ReadonlySet<unknown>,
): ReadonlySet<unknown> => {
  switch (table) {
    case "sources":
      return sliceIds;
    case "decisions":
      return new Set(rows.map((row) => row["id"]));
    case "supplements":
      return new Set(
        rows.map((row) => row["decisionId"] ?? row["decision_id"]),
      );
    case "citations":
      return new Set(
        rows.flatMap((row) => [
          row["citingDecisionId"] ?? row["citing_decision_id"],
          row["citedDecisionId"] ?? row["cited_decision_id"],
        ]),
      );
  }
};

export type CorpusSliceImportResult = {
  changed: number;
  removed: number;
  projectionsEnqueued: number;
};

/** Replay-safe import order keeps foreign keys valid and delegates idempotence to upserts. */
export const importCorpusSlice = async (
  manifest: CorpusSliceTransferManifest,
  shards: readonly CorpusSliceShard[],
  store: ImportStore,
): Promise<Result<CorpusSliceImportResult, CorpusSliceTransferError>> => {
  const verified = verifyCorpusSliceShards(manifest, shards);
  if (Result.isError(verified)) {
    return Result.err(verified.error);
  }
  const rows = verified.value;
  const decisions = rows.get("decisions");
  if (decisions === undefined) {
    return Result.err(
      new CorpusSliceTransferError({ message: "decisions shard is missing" }),
    );
  }
  const ids = new Set(decisions.map((row) => row["id"]));
  const memberIds = [...ids].map((id) => v.safeParse(v.string(), id));
  if (
    memberIds.some((id) => !id.success) ||
    ids.size !== manifest.corpus.memberCount ||
    sha256Hex(
      memberIds
        .flatMap((id) => (id.success ? [id.output] : []))
        .toSorted()
        .join("\n"),
    ) !== manifest.corpus.memberIdsSha256
  ) {
    return Result.err(
      new CorpusSliceTransferError({
        message:
          "decisions shard membership does not match the corpus manifest",
      }),
    );
  }
  let changed = 0;
  let projectionsEnqueued = 0;
  for (const table of [
    "sources",
    "decisions",
    "supplements",
    "citations",
  ] as const) {
    const tableRows = rows.get(table);
    if (tableRows === undefined) {
      return Result.err(
        new CorpusSliceTransferError({ message: `${table} shard is missing` }),
      );
    }
    for (
      let offset = 0;
      offset < tableRows.length;
      offset += IMPORT_BATCH_SIZE
    ) {
      const batchRows = tableRows.slice(offset, offset + IMPORT_BATCH_SIZE);
      const batch = await store.upsertAndRecordProjectionDesiredState(
        table,
        batchRows,
        projectionIdsForBatch(table, batchRows, ids),
      );
      changed += batch.changed;
      projectionsEnqueued += batch.projectionsEnqueued;
    }
  }
  const supplements = rows.get("supplements");
  const citations = rows.get("citations");
  if (supplements === undefined || citations === undefined) {
    return Result.err(
      new CorpusSliceTransferError({ message: "dependent shard is missing" }),
    );
  }
  const reconciliation = await store.reconcileDependents(
    ids,
    supplements,
    citations,
  );
  changed += reconciliation.changed;
  projectionsEnqueued += reconciliation.projectionsEnqueued;
  const removal =
    await store.removeDecisionsExceptAndRecordProjectionDesiredState(ids);
  projectionsEnqueued += removal.projectionsEnqueued;
  return Result.ok({
    changed,
    removed: removal.removedIds.length,
    projectionsEnqueued,
  });
};
