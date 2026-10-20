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
  for (const row of [...decisions, ...supplements]) {
    for (const field of [
      "sourceRawS3Key",
      "corpusTextS3Key",
      "corpusAstS3Key",
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
    encodeShard(
      "supplements",
      supplements.filter((row) =>
        ids.has(row["decisionId"] ?? row["decision_id"]),
      ),
    ),
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
  const parsed = v.safeParse(transferManifestSchema, decoded);
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
  const manifest = { corpus: corpus.value, shards: parsed.output.shards };
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
  upsert: (
    table: Exclude<CorpusSliceShardName, "objects">,
    rows: readonly CorpusSliceTransferRow[],
  ) => Promise<number>;
  removeDecisionsExcept: (ids: ReadonlySet<unknown>) => Promise<number>;
  enqueueProjectionDesiredState: (ids: ReadonlySet<unknown>) => Promise<number>;
};

const IMPORT_BATCH_SIZE = 500;

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
  let changed = 0;
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
      changed += await store.upsert(
        table,
        tableRows.slice(offset, offset + IMPORT_BATCH_SIZE),
      );
    }
  }
  const removed = await store.removeDecisionsExcept(ids);
  const projectionsEnqueued =
    changed + removed === 0
      ? 0
      : await store.enqueueProjectionDesiredState(ids);
  return Result.ok({ changed, removed, projectionsEnqueued });
};
