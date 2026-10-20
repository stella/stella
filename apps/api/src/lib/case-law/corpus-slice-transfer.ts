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
  const objectKeys = new Set<string>();
  const includedSupplements = supplements.filter((row) =>
    ids.has(row["decisionId"] ?? row["decision_id"]),
  );
  const includedSources = new Set(
    [...decisions, ...includedSupplements].map(
      (row) => row["sourceId"] ?? row["source_id"],
    ),
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

export type CorpusSliceTransferStorage = {
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
