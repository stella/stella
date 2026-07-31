import { panic } from "better-result";
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawCorpusIndexBackfills,
  CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS,
  caseLawIndexJobs,
  caseLawSources,
} from "@/api/db/schema";
import {
  isRedistributable,
  type CorpusSourceDescriptor,
} from "@/api/handlers/case-law/corpus-source";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { SafeId } from "@/api/lib/branded-types";
import { redistributableCaseLawSource } from "@/api/lib/case-law/redistribution";
import type { CorpusChunk } from "@/api/lib/corpus-index/chunking";
import {
  chunkDocument,
  formatHeadingPath,
} from "@/api/lib/corpus-index/chunking";
import type {
  CorpusDocumentPayload,
  CorpusIndexAdapter,
} from "@/api/lib/corpus-index/core";
import {
  createCorpusIndexer,
  resolveMarkedRowIds,
} from "@/api/lib/corpus-index/core";
import {
  timestampCasToken,
  type TimestampCasToken,
} from "@/api/lib/db/timestamp-cas";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

/**
 * corpus index search-projection maintenance for the `case_law` family.
 * Domain adapter over the shared core (lib/corpus-index/core.ts): supplies the
 * case-law tables, batch queries, and per-decision document shape; the core
 * owns the S3-chunked load, per-group ingest, compare-and-set commit, and audit
 * trail (case_law_index_jobs). Per-jurisdiction indexes (`case_law_v1_<country>`)
 * with the license gate in SQL so non-redistributable sources never enter the
 * scan.
 *
 * Case law is indexed at passage granularity: a decision projects to one
 * search document per passage of its AST, all carrying the same doc-level
 * fields so every existing filter (court, date, language, source, authority)
 * still applies. Legislation stays document-granular — see
 * `CorpusIndexGranularity` for why the families differ.
 */

type IndexableRow = {
  id: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  caseNumber: string;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  decisionDate: string | null;
  decisionType: string | null;
  citationAuthority: number;
  citationCount: number;
  textS3Key: string | null;
  astS3Key: string | null;
  contentHash: string | null;
  indexedHash: string | null;
  indexedGeneration: string | null;
  updatedAtToken: TimestampCasToken;
};

// Deliberately excludes `fulltext`: it is only the fallback for rows without
// a canonical S3 object, and selecting it for every row would drag megabytes
// of text through one batch transaction. Rows that need it fetch it lazily,
// one small bounded read per document (see the core's loadText / fetchFulltext).
const SELECT_COLUMNS = {
  id: caseLawDecisions.id,
  sourceId: caseLawDecisions.sourceId,
  caseNumber: caseLawDecisions.caseNumber,
  ecli: caseLawDecisions.ecli,
  court: caseLawDecisions.court,
  country: caseLawDecisions.country,
  language: caseLawDecisions.language,
  decisionDate: caseLawDecisions.decisionDate,
  decisionType: caseLawDecisions.decisionType,
  citationAuthority: caseLawDecisions.citationAuthority,
  citationCount: caseLawDecisions.citationCount,
  textS3Key: caseLawDecisions.textS3Key,
  astS3Key: caseLawDecisions.astS3Key,
  contentHash: caseLawDecisions.contentHash,
  indexedHash: caseLawDecisions.indexedHash,
  indexedGeneration: caseLawDecisions.indexedGeneration,
  createdAt: caseLawDecisions.createdAt,
  updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
};

const GENERATION_PAGE_SELECT_COLUMNS = {
  ...SELECT_COLUMNS,
  sourceDescriptor: caseLawSources.descriptor,
};

// A row is indexable once its canonical payload is in object storage.
const hasContent = sql`${caseLawDecisions.contentHash} IS NOT NULL`;

/**
 * Doc-level fields, shared by every passage of a decision. Duplicating them
 * per passage is what keeps the filters working: the engine prunes and filters
 * on the document it scores, and a passage that carried only its text could
 * not be constrained by court or date.
 *
 * Every field here is either raw-tokenized (a filter or facet key) or numeric,
 * so none of them can be hit by a free-text term. That is deliberate — see
 * `title` below, which is the one searchable document-level field and is
 * therefore NOT part of this set.
 */
const buildSharedFields = (row: IndexableRow): Record<string, unknown> => {
  // eslint-disable-next-line no-untyped-updates/no-untyped-updates -- corpus index ingest document, not a DB update
  const doc: Record<string, unknown> = {
    document_id: row.id,
    jurisdiction: row.country,
    source: row.sourceId,
    court: row.court,
    language: row.language,
    citation_authority: row.citationAuthority,
    citation_count: row.citationCount,
  };
  if (row.decisionType !== null) {
    doc["document_type"] = row.decisionType;
  }
  if (row.decisionDate !== null) {
    doc["decision_date"] = row.decisionDate;
    doc["year"] = Number(row.decisionDate.slice(0, 4));
  }
  if (row.ecli !== null) {
    doc["ecli"] = row.ecli;
  }
  if (row.textS3Key !== null) {
    doc["canonical_text_key"] = row.textS3Key;
  }
  if (row.astS3Key !== null) {
    doc["canonical_ast_key"] = row.astS3Key;
  }
  return doc;
};

type ChunkDocInput = {
  shared: Record<string, unknown>;
  documentId: string;
  /** Case number and court, indexed on the opening passage only. */
  title: string;
  chunk: CorpusChunk;
};

/**
 * One passage's search document: the decision's shared fields plus what makes
 * this passage addressable.
 *
 * `chunk_id` is deterministic (`<decisionId>:<seq>`) so the same input always
 * produces the same document identities; it is what an operator greps for when
 * reconciling a decision against the index. Replacement, though, is by
 * `document_id` — see the shared core's `remove`.
 *
 * `title` is searchable (case-number and court-name lookups run through it),
 * which makes it the one field whose fan-out matters: copied onto every
 * passage, a query for a court's name would match all of them, and a single
 * long judgment could fill an entire scan window with hundreds of
 * identically-scoring hits before the reader ever saw a second decision. It
 * goes on the opening passage alone, so a title match contributes exactly one
 * hit per document — the same fan-out the document-granular layout had — and
 * groups to the top of the decision, which is where a case-number match should
 * land anyway.
 */
const buildChunkDoc = ({
  shared,
  documentId,
  title,
  chunk,
}: ChunkDocInput): Record<string, unknown> => ({
  ...shared,
  chunk_id: `${documentId}:${chunk.seq}`,
  seq: chunk.seq,
  text: chunk.text,
  ...(chunk.seq === 0 ? { title } : {}),
  ...(chunk.anchorId === null ? {} : { anchor_id: chunk.anchorId }),
  ...(chunk.headingPath.length === 0
    ? {}
    : { heading_path: formatHeadingPath(chunk.headingPath) }),
});

/** Build one search document per passage, omitting empty optional fields. */
const buildDocs = (
  row: IndexableRow,
  { text, ast }: CorpusDocumentPayload,
): Record<string, unknown>[] => {
  const shared = buildSharedFields(row);
  const title = `${row.caseNumber} — ${row.court}`;
  return chunkDocument({
    ast: hasUsableAst(ast) ? ast : null,
    fallbackText: text,
  }).map((chunk) =>
    buildChunkDoc({ shared, documentId: row.id, title, chunk }),
  );
};

/** Exported for the database-backed test of the batched CAS mark. */
export const caseLawCorpusIndexAdapter = {
  family: "case_law",
  captureStep: "backfillCorpusIndex.loadText",
  granularity: "passage",
  buildDocs,
  readCorpusText,
  readCorpusAst,
  // The incremental scan deliberately carries no ORDER BY. Any pick order makes
  // progress (indexed rows leave the pending set), while ordering by
  // created_at steers the planner onto the created_at index and
  // row-by-row heap filtering; the selective content-hash index is what
  // these scans need.
  selectMissing: async (scopedDb, { limit }) => {
    // Hash-null rows are the durable pending set: new rows and every refresh
    // clear this field while retaining the old generation pointer needed to
    // delete a moved jurisdiction copy. The partial index keeps this bounded.
    const fresh = await scopedDb((tx) =>
      tx
        .select(SELECT_COLUMNS)
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            hasContent,
            redistributableCaseLawSource,
            isNull(caseLawDecisions.indexedHash),
          ),
        )
        .limit(limit),
    );
    if (fresh.length >= limit) {
      return fresh;
    }
    // A generation rebuild is deliberately not expressed as
    // a generation-mismatch predicate: it grows into an unbounded
    // heap scan. The build runner owns the durable keyset walk; this daemon
    // path only services the indexed pending set.
    return fresh;
  },
  selectStale: async (scopedDb, { generation, limit }) =>
    await scopedDb((tx) =>
      tx
        .select(SELECT_COLUMNS)
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            hasContent,
            redistributableCaseLawSource,
            isNotNull(caseLawDecisions.indexedHash),
            sql`${caseLawDecisions.indexedGeneration} = (${generation} || '_' || lower(${caseLawDecisions.country}))`,
            sql`${caseLawDecisions.indexedHash} IS DISTINCT FROM ${caseLawDecisions.contentHash}`,
          ),
        )
        .limit(limit),
    ),
  fetchFulltext: async (scopedDb, id) => {
    const fallback = await scopedDb((tx) =>
      tx
        .select({ fulltext: caseLawDecisions.fulltext })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, id))
        .limit(1),
    );
    return fallback.at(0)?.fulltext ?? null;
  },
  markIndexedBatch: async (tx, { rows, indexId, now }) => {
    if (rows.length === 0) {
      return new Set();
    }
    // audit: skip — search index maintenance; rebuilds derived state
    // One statement for the whole request: each tuple carries the row's
    // expected pre-state, so every row keeps its individual compare-and-set
    // while the batch pays a single round-trip. The mark deliberately leaves
    // updated_at alone — bookkeeping must not read as a content change to
    // other compare-and-set scans — so the expected generation is part of
    // the pre-state: without it, two overlapping builds of a hash-current
    // row would both match and both record success.
    const tuples = sql.join(
      rows.map(
        (row) =>
          sql`(${row.id}::uuid, ${row.contentHash}::text, ${row.indexedHash}::text, ${row.indexedGeneration}::text, ${row.updatedAtToken}::timestamptz)`,
      ),
      sql`, `,
    );
    const marked: unknown = await tx.execute(sql`
      UPDATE ${caseLawDecisions} AS d
      SET indexed_hash = v.content_hash,
          indexed_generation = ${indexId},
          indexed_at = ${now.toISOString()}::timestamptz
      FROM (VALUES ${tuples}) AS v(id, content_hash, expected_hash, expected_generation, expected_updated)
      WHERE d.id = v.id
        AND d.indexed_hash IS NOT DISTINCT FROM v.expected_hash
        AND d.indexed_generation IS NOT DISTINCT FROM v.expected_generation
        AND d.updated_at IS NOT DISTINCT FROM v.expected_updated
      RETURNING d.id
    `);
    return resolveMarkedRowIds(marked, rows);
  },
  insertSucceededJobs: async (tx, { rows, indexId }) => {
    // audit: skip — append-only index-job rows ARE the indexing audit trail
    await tx.insert(caseLawIndexJobs).values(
      rows.map((row) => ({
        decisionId: row.id,
        generation: indexId,
        operation: "index" as const,
        status: "succeeded" as const,
        contentHash: row.contentHash,
      })),
    );
  },
  recordJobs: async (scopedDb, jobs, generation) => {
    if (jobs.length === 0) {
      return;
    }
    // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
    await scopedDb((tx) => {
      // audit: skip — append-only index-job rows ARE the indexing audit trail
      return tx.insert(caseLawIndexJobs).values(
        jobs.map((job) => ({
          decisionId: job.entityId,
          generation,
          operation: job.operation,
          status: job.status,
          contentHash: job.contentHash,
          errorMessage: job.errorMessage ?? null,
        })),
      );
    });
  },
} satisfies CorpusIndexAdapter<"caseLawDecision", IndexableRow>;

const indexer = createCorpusIndexer<"caseLawDecision", IndexableRow>(
  caseLawCorpusIndexAdapter,
);

export const loadDocsForBatch = indexer.loadDocsForBatch;

type IncrementalBackfillDependencies = {
  backfill: typeof indexer.backfill;
  newestRebuildGeneration: (
    scopedDb: Parameters<typeof indexer.backfill>[0],
  ) => Promise<string | null>;
};

/**
 * Prevents an older incremental writer from racing a newer generation build.
 * Once a rebuild checkpoint exists, only that generation may advance corpus
 * index pointers; compare-and-set handles a batch that was already in flight.
 */
export const createCaseLawIncrementalBackfill =
  ({ backfill, newestRebuildGeneration }: IncrementalBackfillDependencies) =>
  async (
    scopedDb: Parameters<typeof indexer.backfill>[0],
    batchSize: number,
    generation: string,
    options?: Parameters<typeof indexer.backfill>[3],
  ): Promise<number> => {
    const newestGeneration = await newestRebuildGeneration(scopedDb);
    if (newestGeneration !== null && newestGeneration !== generation) {
      throw new CorpusIndexError({
        message: `incremental generation ${generation} is behind rebuild ${newestGeneration}`,
      });
    }
    return await backfill(scopedDb, batchSize, generation, options);
  };

export const backfillCorpusIndex = createCaseLawIncrementalBackfill({
  backfill: indexer.backfill,
  newestRebuildGeneration: async (scopedDb) =>
    await scopedDb(
      async (tx) =>
        (
          await tx
            .select({ generation: caseLawCorpusIndexBackfills.generation })
            .from(caseLawCorpusIndexBackfills)
            .orderBy(desc(caseLawCorpusIndexBackfills.snapshotAt))
            .limit(1)
        ).at(0)?.generation ?? null,
    ),
});

const BACKFILL_STATUS = {
  ADVANCED: "advanced",
  BUSY: "busy",
  COMPLETE: "complete",
} as const;

const BACKFILL_LEASE_MS = 30 * 60 * 1000;

type GenerationBackfillCheckpoint = {
  cursorCreatedAt: Date | null;
  cursorId: SafeId<"caseLawDecision"> | null;
  generation: string;
  snapshotAt: Date;
};

type GenerationBackfillRow = IndexableRow & {
  createdAt: Date;
  sourceDescriptor: CorpusSourceDescriptor | null;
};

type GenerationBackfillResult =
  | {
      indexed: number;
      status: typeof BACKFILL_STATUS.ADVANCED;
    }
  | {
      indexed: 0;
      status: typeof BACKFILL_STATUS.BUSY | typeof BACKFILL_STATUS.COMPLETE;
    };

type GenerationBackfillDependencies = {
  backfillIncremental: typeof backfillCorpusIndex;
  backfillRows: (
    scopedDb: Parameters<typeof backfillCorpusIndex>[0],
    rows: readonly IndexableRow[],
    generation: string,
    options: {
      beforeDatabaseMark: (tx: Transaction) => Promise<void>;
      beforeRemoteEffect: () => Promise<void>;
    },
  ) => Promise<number>;
  newLeaseToken: () => string;
};

const sameCursor = ({
  checkpoint,
}: {
  checkpoint: GenerationBackfillCheckpoint;
}) =>
  sql`${caseLawCorpusIndexBackfills.cursorCreatedAt} IS NOT DISTINCT FROM ${checkpoint.cursorCreatedAt}
      AND ${caseLawCorpusIndexBackfills.cursorId} IS NOT DISTINCT FROM ${checkpoint.cursorId}`;

const nextLeaseExpiry = () =>
  sql<Date>`now() + (${BACKFILL_LEASE_MS} * interval '1 millisecond')`;

const ownsUnexpiredLease = ({
  checkpoint,
  leaseToken,
}: {
  checkpoint: GenerationBackfillCheckpoint;
  leaseToken: string;
}) =>
  and(
    eq(
      caseLawCorpusIndexBackfills.status,
      CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
    ),
    sameCursor({ checkpoint }),
    eq(caseLawCorpusIndexBackfills.leaseToken, leaseToken),
    sql`${caseLawCorpusIndexBackfills.leaseExpiresAt} > now()`,
  );

const selectGenerationBackfillPage = async (
  scopedDb: Parameters<typeof backfillCorpusIndex>[0],
  {
    batchSize,
    checkpoint,
  }: { batchSize: number; checkpoint: GenerationBackfillCheckpoint },
): Promise<GenerationBackfillRow[]> =>
  await scopedDb((tx) =>
    tx
      .select(GENERATION_PAGE_SELECT_COLUMNS)
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          lte(caseLawDecisions.createdAt, checkpoint.snapshotAt),
          checkpoint.cursorCreatedAt === null
            ? undefined
            : sql`(${caseLawDecisions.createdAt}, ${caseLawDecisions.id}) > (${checkpoint.cursorCreatedAt}, ${checkpoint.cursorId})`,
        ),
      )
      .orderBy(asc(caseLawDecisions.createdAt), asc(caseLawDecisions.id))
      .limit(batchSize),
  );

const isEligibleForGeneration = (
  row: GenerationBackfillRow,
  generation: string,
): boolean =>
  row.contentHash !== null &&
  isRedistributable(row.sourceDescriptor) &&
  (row.indexedGeneration !== corpusIndexId(generation, row.country) ||
    row.indexedHash !== row.contentHash);

const withoutSourceDescriptor = ({
  sourceDescriptor: _sourceDescriptor,
  ...row
}: GenerationBackfillRow): IndexableRow => row;

/**
 * Creates the case-law generation-rebuild runner. Its explicit dependencies
 * make the state machine deterministic in database tests while production
 * retains the shared indexer's normal S3, CAS, and audit path.
 */
export const createCaseLawGenerationBackfill =
  ({
    backfillIncremental,
    backfillRows,
    newLeaseToken,
  }: GenerationBackfillDependencies) =>
  async (
    scopedDb: Parameters<typeof backfillCorpusIndex>[0],
    batchSize: number,
    generation: string,
  ): Promise<GenerationBackfillResult> => {
    const reconcilePending = async (): Promise<GenerationBackfillResult> => {
      const pendingIndexed = await backfillIncremental(
        scopedDb,
        batchSize,
        generation,
      );
      return pendingIndexed > 0
        ? { indexed: pendingIndexed, status: BACKFILL_STATUS.ADVANCED }
        : { indexed: 0, status: BACKFILL_STATUS.COMPLETE };
    };
    const checkpoint = await scopedDb(async (tx) => {
      // audit: skip — the checkpoint is the durable audit trail for this derived projection rebuild
      const existing = (
        await tx
          .select()
          .from(caseLawCorpusIndexBackfills)
          .where(eq(caseLawCorpusIndexBackfills.generation, generation))
          .limit(1)
      ).at(0);
      if (existing) {
        return existing;
      }

      // Wait for decision writes that already acquired their table lock, then
      // capture statement time while new writers are held out. Together with
      // the decision column's clock_timestamp() default, no later commit can
      // appear behind this rebuild's (created_at,id) cursor.
      await tx.execute(sql`LOCK TABLE ${caseLawDecisions} IN SHARE MODE`);
      const inserted = await tx
        .insert(caseLawCorpusIndexBackfills)
        .values({ generation, snapshotAt: sql`clock_timestamp()` })
        .onConflictDoNothing()
        .returning();
      const created = inserted.at(0);
      if (created) {
        return created;
      }

      const concurrent = (
        await tx
          .select()
          .from(caseLawCorpusIndexBackfills)
          .where(eq(caseLawCorpusIndexBackfills.generation, generation))
          .limit(1)
      ).at(0);
      if (!concurrent) {
        panic("case-law corpus generation checkpoint disappeared");
      }
      return concurrent;
    });
    if (checkpoint.status === CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE) {
      return await reconcilePending();
    }

    const leaseToken = newLeaseToken();
    const claimed = await scopedDb(async (tx) => {
      // audit: skip — lease ownership is ephemeral coordination recorded on the checkpoint itself
      const rows = await tx
        .update(caseLawCorpusIndexBackfills)
        .set({ leaseExpiresAt: nextLeaseExpiry(), leaseToken })
        .where(
          and(
            eq(caseLawCorpusIndexBackfills.generation, generation),
            eq(
              caseLawCorpusIndexBackfills.status,
              CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
            ),
            sameCursor({ checkpoint }),
            or(
              isNull(caseLawCorpusIndexBackfills.leaseExpiresAt),
              lte(caseLawCorpusIndexBackfills.leaseExpiresAt, sql`now()`),
            ),
          ),
        )
        .returning();
      return rows.at(0);
    });
    if (!claimed) {
      return { indexed: 0, status: BACKFILL_STATUS.BUSY };
    }

    const claimedCheckpoint: GenerationBackfillCheckpoint = {
      cursorCreatedAt: claimed.cursorCreatedAt,
      cursorId: claimed.cursorId,
      generation: claimed.generation,
      snapshotAt: claimed.snapshotAt,
    };
    const renewLeaseInTransaction = async (tx: Transaction): Promise<void> => {
      // audit: skip — renewal extends ephemeral ownership without changing rebuild progress
      const renewed = (
        await tx
          .update(caseLawCorpusIndexBackfills)
          .set({ leaseExpiresAt: nextLeaseExpiry() })
          .where(
            and(
              eq(caseLawCorpusIndexBackfills.generation, generation),
              ownsUnexpiredLease({
                checkpoint: claimedCheckpoint,
                leaseToken,
              }),
            ),
          )
          .returning({
            generation: caseLawCorpusIndexBackfills.generation,
          })
      ).at(0);
      if (!renewed) {
        throw new ConcurrentModificationError({
          message: "Case-law corpus generation lease was lost",
        });
      }
    };
    const renewLease = async (): Promise<void> => {
      await scopedDb(renewLeaseInTransaction);
    };
    const page = await selectGenerationBackfillPage(scopedDb, {
      batchSize,
      checkpoint: claimedCheckpoint,
    });
    const last = page.at(-1);
    if (!last) {
      const completed = await scopedDb(async (tx) => {
        // audit: skip — completion is derived projection state recorded on the checkpoint itself
        const rows = await tx
          .update(caseLawCorpusIndexBackfills)
          .set({
            leaseExpiresAt: null,
            leaseToken: null,
            status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
          })
          .where(
            and(
              eq(caseLawCorpusIndexBackfills.generation, generation),
              ownsUnexpiredLease({
                checkpoint: claimedCheckpoint,
                leaseToken,
              }),
            ),
          )
          .returning({ generation: caseLawCorpusIndexBackfills.generation });
        return rows.at(0);
      });
      return completed
        ? await reconcilePending()
        : { indexed: 0, status: BACKFILL_STATUS.BUSY };
    }

    const rows = page
      .filter((row) => isEligibleForGeneration(row, generation))
      .map(withoutSourceDescriptor);
    let indexed: number;
    try {
      indexed = await backfillRows(scopedDb, rows, generation, {
        beforeDatabaseMark: renewLeaseInTransaction,
        beforeRemoteEffect: renewLease,
      });
      if (indexed !== rows.length) {
        throw new CorpusIndexError({
          message: "generation backfill page did not reach a fixed point",
        });
      }
    } catch (error) {
      // Keep the cursor intact, but do not make a transient search/S3 failure
      // wait for a stale lease before its durable retry.
      await scopedDb(async (tx) => {
        // audit: skip — releasing a failed lease preserves the durable cursor for replay
        const released = await tx
          .update(caseLawCorpusIndexBackfills)
          .set({ leaseExpiresAt: null, leaseToken: null })
          .where(
            and(
              eq(caseLawCorpusIndexBackfills.generation, generation),
              ownsUnexpiredLease({
                checkpoint: claimedCheckpoint,
                leaseToken,
              }),
            ),
          );
        return released;
      });
      throw error;
    }

    const advanced = await scopedDb(async (tx) => {
      // audit: skip — cursor advancement is the durable audit trail for this derived rebuild
      const advancedRows = await tx
        .update(caseLawCorpusIndexBackfills)
        .set({
          cursorCreatedAt: last.createdAt,
          cursorId: last.id,
          leaseExpiresAt: null,
          leaseToken: null,
        })
        .where(
          and(
            eq(caseLawCorpusIndexBackfills.generation, generation),
            ownsUnexpiredLease({
              checkpoint: claimedCheckpoint,
              leaseToken,
            }),
          ),
        )
        .returning({ generation: caseLawCorpusIndexBackfills.generation });
      return advancedRows.at(0);
    });
    return advanced
      ? { indexed, status: BACKFILL_STATUS.ADVANCED }
      : { indexed: 0, status: BACKFILL_STATUS.BUSY };
  };

/**
 * Advance one durable generation-rebuild page. The page is bounded by the
 * `(created_at,id)` cursor before any generation comparison is made, so a
 * cutover never turns into a table scan.
 */
export const backfillCorpusIndexGenerationPage =
  createCaseLawGenerationBackfill({
    backfillIncremental: backfillCorpusIndex,
    backfillRows: indexer.backfillRows,
    newLeaseToken: () => Bun.randomUUIDv7(),
  });
export const removeDecisionFromCorpusIndex = indexer.remove;
