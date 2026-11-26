import { Result, TaggedError } from "better-result";
import { asc, eq, sql } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { decisionParagraphNumbering } from "@stll/legal-ast/court-paragraph-number";
import { extractCourtParagraphNumbers } from "@stll/legal-ast/court-paragraph-numbers";
import {
  type Block,
  persistedDocumentAstSchema,
} from "@stll/legal-ast/document-ast";

import { caseLawSources, publishedCaseLawDecisions } from "@/api/db/schema";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
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
import {
  COURT_PARAGRAPH_NUMBERING_CONVENTIONS,
  type CourtParagraphReader,
} from "@/api/lib/legal-search/processed-field-inventory";
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

/**
 * The court paragraph numbers of the valid stored decisions, one generic
 * measure for every source: whether the stored paragraphs carry the court's
 * numbers (`court`), carry none (`none`), and of those, how many still print
 * a numbering in their text that the shared extractor would read
 * (`noneButPrinted`): labels a reparse with the current parser restores. A
 * source whose `reader` reads numbers and whose `none` dominates an older
 * parser version holds decisions stored before its parser read them.
 */
type CorpusParagraphNumberingCounts = {
  /** The source's declared reader, or null for a key no source declares. */
  reader: CourtParagraphReader | null;
  court: number;
  none: number;
  noneButPrinted: number;
};

type CorpusAstCensusCounts = {
  adapterKey: string;
  parserVersion: number | null;
  published: number;
  valid: number;
  invalid: number;
  withoutAst: number;
  unreadable: number;
  paragraphNumbering: CorpusParagraphNumberingCounts;
};

const DECLARED_READERS: ReadonlyMap<string, CourtParagraphReader> = new Map(
  Object.entries(COURT_PARAGRAPH_NUMBERING_CONVENTIONS),
);

const declaredReader = (adapterKey: string): CourtParagraphReader | null =>
  DECLARED_READERS.get(adapterKey) ?? null;

/** Count one valid stored decision's paragraph numbering. */
export const countParagraphNumbering = (
  counts: CorpusParagraphNumberingCounts,
  blocks: readonly Block[],
): void => {
  if (decisionParagraphNumbering(blocks) === "court") {
    counts.court++;
    return;
  }
  counts.none++;
  if (extractCourtParagraphNumbers(blocks).type === "numbered") {
    counts.noneButPrinted++;
  }
};

/** Each census read is one bounded page; a slow page fails rather than piling up. */
const CENSUS_STATEMENT_TIMEOUT_MS = 5000;

export const readCorpusAstCensusBatch = async (
  ingestionDb: CaseLawIngestionHandle,
  after: string | undefined,
): Promise<CorpusAstCensusRow[]> =>
  await ingestionDb(async (tx) => {
    await setSharedStatementTimeout(tx, CENSUS_STATEMENT_TIMEOUT_MS);
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
      await setSharedStatementTimeout(tx, CENSUS_STATEMENT_TIMEOUT_MS);
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
          paragraphNumbering: {
            reader: declaredReader(row.adapterKey),
            court: 0,
            none: 0,
            noneButPrinted: 0,
          },
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
        continue;
      }
      const ast = v.safeParse(persistedDocumentAstSchema, payload.value);
      if (ast.success) {
        count.valid++;
        countParagraphNumbering(count.paragraphNumbering, ast.output.blocks);
      } else {
        count.invalid++;
      }
    }
    after = last.id;
    await pause();
  }
};
