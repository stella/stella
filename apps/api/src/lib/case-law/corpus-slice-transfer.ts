import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  type CorpusSliceManifest,
  parseCorpusSliceManifest,
} from "@/api/lib/case-law/corpus-slice";

export const CORPUS_SLICE_EXPORT_TABLES = [
  "case_law_sources",
  "case_law_decisions",
  "case_law_decision_supplements",
  "case_law_citations",
] as const;

type CorpusSliceShardName =
  | "sources"
  | "decisions"
  | "supplements"
  | "citations"
  | "objects";

export type CorpusSliceTransferManifest = {
  corpus: CorpusSliceManifest;
  shards: readonly {
    name: CorpusSliceShardName;
    rows: number;
    sha256: string;
  }[];
};

export class CorpusSliceTransferError extends TaggedError(
  "CorpusSliceTransferError",
)<{ message: string }> {}

export type CorpusSliceTransferStorage = {
  write: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  openWriter: (
    key: string,
    contentType: string,
  ) => Promise<{
    write: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }>;
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
