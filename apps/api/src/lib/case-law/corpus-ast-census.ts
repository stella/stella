import { Result, TaggedError } from "better-result";
import { asc, eq, sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { persistedDocumentAstSchema } from "@stll/legal-ast/document-ast";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import type { CaseLawIngestionHandle } from "@/api/lib/case-law/maintenance-lane";
import { zstdDecompressToStringBounded } from "@/api/lib/compression";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  CORPUS_TRANSFER_MAX_BYTES,
  readCorpusBytesAt,
} from "@/api/lib/legal-search/corpus-storage";
import {
  corpusTombstoneReaderForTx,
  prefetchCorpusTombstones,
} from "@/api/lib/legal-search/corpus-tombstones";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import { emptyAstSchema } from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import { withTimeout } from "@/api/lib/with-timeout";

const CENSUS_BATCH_SIZE = 50;
const CENSUS_PAUSE_MS = 250;
const CENSUS_PAYLOAD_TIMEOUT_MS = 30_000;

class CorpusAstCensusPayloadError extends TaggedError(
  "CorpusAstCensusPayloadError",
)<{
  message: string;
  cause: unknown;
}> {}

type CorpusAstCensusRow = {
  id: string;
  adapterKey: string;
  parserVersion: number | null;
  astS3Key: string | null;
  documentAst: unknown;
};

type CorpusAstCensusCounts = {
  adapterKey: string;
  parserVersion: number | null;
  published: number;
  valid: number;
  invalid: number;
  withoutAst: number;
  unreadable: number;
};

export const readCorpusAstCensusBatch = async (
  ingestionDb: CaseLawIngestionHandle,
  after: string | undefined,
): Promise<CorpusAstCensusRow[]> =>
  await ingestionDb(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return await tx
      .select({
        id: publishedCaseLawDecisions.id,
        adapterKey: caseLawSources.adapterKey,
        parserVersion: publishedCaseLawDecisions.parserVersion,
        astS3Key: publishedCaseLawDecisions.astS3Key,
        documentAst: publishedCaseLawDecisions.documentAst,
      })
      .from(publishedCaseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
      )
      .where(
        after === undefined
          ? undefined
          : sql`${publishedCaseLawDecisions.id} > ${after}::uuid`,
      )
      .orderBy(asc(publishedCaseLawDecisions.id))
      .limit(CENSUS_BATCH_SIZE);
  });

export const censusTombstoneReader =
  (ingestionDb: CaseLawIngestionHandle): CorpusTombstoneReader =>
  async (locations) =>
    await ingestionDb(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      return await corpusTombstoneReaderForTx(tx)(locations);
    });

// Read the bounded raw payload: readCorpusAst already rejects the values being counted.
export const readCorpusAstCensusPayload = async (
  storedKey: string,
  readTombstones: CorpusTombstoneReader,
): Promise<unknown> =>
  await withTimeout(
    async (signal) => {
      const bytes = await readCorpusBytesAt({
        location: parseCorpusLocation(storedKey),
        maxBytes: CORPUS_TRANSFER_MAX_BYTES,
        signal,
        readTombstones,
      });
      const decoded = await zstdDecompressToStringBounded(
        bytes,
        LIMITS.corpusPayloadMaxDecompressedBytes,
      );
      const parsed: unknown = JSON.parse(decoded);
      return parsed;
    },
    { label: "corpus-ast-census", timeoutMs: CENSUS_PAYLOAD_TIMEOUT_MS },
  );

type CorpusAstCensusOptions = {
  readBatch: (after: string | undefined) => Promise<CorpusAstCensusRow[]>;
  readPayload: (
    storedKey: string,
    readTombstones: CorpusTombstoneReader,
  ) => Promise<unknown>;
  readTombstones: CorpusTombstoneReader;
  pause?: () => Promise<void>;
};

export const corpusAstCensus = async ({
  readBatch,
  readPayload,
  readTombstones,
  pause = async () => {
    await sleep(CENSUS_PAUSE_MS);
  },
}: CorpusAstCensusOptions): Promise<CorpusAstCensusCounts[]> => {
  const counts = new Map<string, CorpusAstCensusCounts>();
  let after: string | undefined;
  for (;;) {
    const rows = await readBatch(after);
    const last = rows.at(-1);
    if (last === undefined) {
      return [...counts.values()].toSorted(
        (left, right) =>
          compareCodeUnit(left.adapterKey, right.adapterKey) ||
          (left.parserVersion ?? -1) - (right.parserVersion ?? -1),
      );
    }
    const batchTombstones = await prefetchCorpusTombstones(
      rows.flatMap(({ astS3Key }) => (astS3Key === null ? [] : [astS3Key])),
      readTombstones,
    );
    for (const row of rows) {
      const key = JSON.stringify([row.adapterKey, row.parserVersion]);
      let count = counts.get(key);
      if (count === undefined) {
        count = {
          adapterKey: row.adapterKey,
          parserVersion: row.parserVersion,
          published: 0,
          valid: 0,
          invalid: 0,
          withoutAst: 0,
          unreadable: 0,
        };
        counts.set(key, count);
      }
      count.published++;
      const payload = await Result.tryPromise({
        try: async () =>
          row.astS3Key === null
            ? row.documentAst
            : await readPayload(row.astS3Key, batchTombstones),
        catch: (cause) =>
          new CorpusAstCensusPayloadError({
            message: "Cannot read census AST payload",
            cause,
          }),
      });
      if (Result.isError(payload)) {
        count.unreadable++;
        continue;
      }
      if (payload.value === null || v.is(emptyAstSchema, payload.value)) {
        count.withoutAst++;
      } else if (
        v.safeParse(persistedDocumentAstSchema, payload.value).success
      ) {
        count.valid++;
      } else {
        count.invalid++;
      }
    }
    after = last.id;
    await pause();
  }
};
