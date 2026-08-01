import { panic } from "better-result";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexProjections,
  caseLawCorpusIndexSourceReconciliations,
  caseLawCorpusIndexWriterLeases,
  CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS,
  type CaseLawCorpusIndexBackfillStatus,
  type CaseLawCorpusIndexProjectionAction,
  caseLawIndexJobs,
  caseLawSources,
} from "@/api/db/schema";
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
  FencedRemoteEffect,
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
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import {
  isRedistributable,
  type CorpusSourceDescriptor,
} from "@/api/lib/legal-search/corpus-source";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/lib/legal-search/corpus-storage";
import {
  corpusIndexId,
  isCorpusIndexGeneration,
  tryCorpusIndexGeneration,
} from "@/api/lib/legal-search/index-naming";

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
  generationIndexId: string | null;
  generationPendingAction: CaseLawCorpusIndexProjectionAction | null;
  generationPendingIndexIds: string[];
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
  generationIndexId: sql<string | null>`null`,
  generationPendingAction: sql<CaseLawCorpusIndexProjectionAction | null>`null`,
  generationPendingIndexIds: sql<string[]>`'{}'::varchar(64)[]`,
  createdAt: caseLawDecisions.createdAt,
  updatedAtToken: timestampCasToken(caseLawDecisions.updatedAt),
};

const GENERATION_PAGE_SELECT_COLUMNS = {
  ...SELECT_COLUMNS,
  generationIndexId: caseLawCorpusIndexProjections.indexId,
  generationIndexedHash: caseLawCorpusIndexProjections.indexedHash,
  generationPendingAction: caseLawCorpusIndexProjections.pendingAction,
  generationPendingIndexIds: sql<
    string[]
  >`coalesce(${caseLawCorpusIndexProjections.pendingIndexIds}, '{}'::varchar(64)[])`,
  sourceDescriptor: caseLawSources.descriptor,
};

// A row is indexable once its canonical payload is in object storage.
const hasContent = sql`${caseLawDecisions.contentHash} IS NOT NULL`;

const commitCurrentGenerationProjection = async (
  tx: Transaction,
  {
    generation,
    indexId,
    rows,
  }: {
    generation: string;
    indexId: string;
    rows: readonly IndexableRow[];
  },
): Promise<Set<SafeId<"caseLawDecision">>> => {
  if (rows.length === 0) {
    return new Set();
  }
  const tuples = sql.join(
    rows.map(
      (row) =>
        sql`(${row.id}::uuid, ${row.contentHash}::text, ${row.updatedAtToken}::timestamptz)`,
    ),
    sql`, `,
  );
  // The generation queue is the commit marker for a rebuild. Locking the
  // decision rows makes the content/update-token check atomic with queue
  // removal; a refresh that races this commit waits, then re-enqueues its
  // newer hash after the transaction releases the row lock.
  // audit: skip — search index maintenance; rebuilds derived state
  const marked: unknown = await tx.execute(sql`
    WITH expected(id, content_hash, expected_updated) AS (
      VALUES ${tuples}
    ), live AS MATERIALIZED (
      SELECT d.id, d.content_hash
      FROM ${caseLawDecisions} AS d
      INNER JOIN expected AS v ON v.id = d.id
      WHERE d.content_hash IS NOT DISTINCT FROM v.content_hash
        AND d.updated_at IS NOT DISTINCT FROM v.expected_updated
      FOR UPDATE OF d
    ), committed AS (
      INSERT INTO ${caseLawCorpusIndexProjections} AS projection (
        generation,
        decision_id,
        index_id,
        indexed_hash,
        pending_action,
        pending_hash,
        pending_index_ids,
        updated_at
      )
      SELECT ${generation}, live.id, ${indexId}, live.content_hash, null, null, '{}', now()
      FROM live
      ON CONFLICT (generation, decision_id) DO UPDATE
      SET index_id = EXCLUDED.index_id,
          indexed_hash = EXCLUDED.indexed_hash,
          pending_action = CASE
            WHEN projection.pending_hash IS NOT DISTINCT FROM EXCLUDED.indexed_hash
              THEN null
            ELSE projection.pending_action
          END,
          pending_hash = CASE
            WHEN projection.pending_hash IS NOT DISTINCT FROM EXCLUDED.indexed_hash
              THEN null
            ELSE projection.pending_hash
          END,
          pending_index_ids = CASE
            WHEN projection.pending_hash IS NOT DISTINCT FROM EXCLUDED.indexed_hash
              THEN '{}'
            ELSE projection.pending_index_ids
          END,
          updated_at = EXCLUDED.updated_at
      RETURNING decision_id
    )
    SELECT live.id FROM live
  `);
  return resolveMarkedRowIds(marked, rows);
};

const reserveGenerationProjectionTargets = async (
  tx: Transaction,
  { generation, rows }: { generation: string; rows: readonly IndexableRow[] },
): Promise<Set<SafeId<"caseLawDecision">>> => {
  if (rows.length === 0) {
    return new Set();
  }
  const tuples = sql.join(
    rows.map(
      (row) =>
        sql`(${row.id}::uuid, ${row.contentHash}::text, ${row.country}::text, ${corpusIndexId(generation, row.country)}::text, ${row.updatedAtToken}::timestamptz)`,
    ),
    sql`, `,
  );
  // Persist the target before append. A crash can leave an uncommitted copy,
  // but erasure and replay can always discover and delete it.
  // audit: skip — pending projection state is derived rebuild bookkeeping
  const reserved: unknown = await tx.execute(sql`
    WITH expected(id, content_hash, country, index_id, expected_updated) AS (
      VALUES ${tuples}
    ), live AS MATERIALIZED (
      SELECT d.id, d.content_hash, v.index_id
      FROM ${caseLawDecisions} AS d
      INNER JOIN expected AS v ON v.id = d.id
      WHERE d.content_hash IS NOT DISTINCT FROM v.content_hash
        AND d.country = v.country
        AND d.updated_at IS NOT DISTINCT FROM v.expected_updated
        AND d.content_hash IS NOT NULL
      FOR UPDATE OF d
    ), queued AS (
      INSERT INTO ${caseLawCorpusIndexProjections} AS projection (
        generation,
        decision_id,
        pending_action,
        pending_hash,
        pending_index_ids,
        updated_at
      )
      SELECT ${generation}, live.id, 'index', live.content_hash, ARRAY[live.index_id], now()
      FROM live
      ON CONFLICT (generation, decision_id) DO UPDATE
      SET pending_action = EXCLUDED.pending_action,
          pending_hash = EXCLUDED.pending_hash,
          pending_index_ids = ARRAY(
            SELECT DISTINCT target
            FROM unnest(
              projection.pending_index_ids || EXCLUDED.pending_index_ids
            ) AS target
          ),
          updated_at = EXCLUDED.updated_at
      RETURNING decision_id
    )
    SELECT decision_id AS id FROM queued
  `);
  return resolveMarkedRowIds(reserved, rows);
};

const recoverLostGenerationProjectionEffect = async (
  scopedDb: ScopedDb,
  generation: string,
  {
    decisionIds,
    indexId,
  }: {
    decisionIds: readonly SafeId<"caseLawDecision">[];
    indexId: string;
  },
): Promise<void> => {
  if (decisionIds.length === 0) {
    return;
  }
  const ids = sql.join(
    decisionIds.map((decisionId) => sql`${decisionId}::uuid`),
    sql`, `,
  );
  await scopedDb(async (tx) => {
    // A successor may have committed and cleared an older reservation before
    // that older remote request returns. Reinsert the exact index the stale
    // operation touched plus the current-country target: replay deletes both
    // before appending current canonical content.
    // audit: skip — compensating search-index maintenance
    await tx.execute(sql`
      INSERT INTO ${caseLawCorpusIndexProjections} AS projection (
        generation,
        decision_id,
        pending_action,
        pending_hash,
        pending_index_ids,
        updated_at
      )
      SELECT ${generation}, decision.id, 'index', decision.content_hash,
             ARRAY(
               SELECT DISTINCT target
               FROM unnest(ARRAY[
                 ${indexId},
                 ${generation} || '_' || lower(decision.country)
               ]) AS target
             ), now()
      FROM ${caseLawDecisions} AS decision
      WHERE decision.id IN (${ids})
        AND decision.content_hash IS NOT NULL
      ON CONFLICT (generation, decision_id) DO UPDATE
      SET pending_action = EXCLUDED.pending_action,
          pending_hash = EXCLUDED.pending_hash,
          pending_index_ids = ARRAY(
            SELECT DISTINCT target
            FROM unnest(
              projection.pending_index_ids || EXCLUDED.pending_index_ids
            ) AS target
          ),
          updated_at = EXCLUDED.updated_at
    `);
  });
};

const clearTerminalGenerationPending = async (
  tx: Transaction,
  { generation, rows }: { generation: string; rows: readonly IndexableRow[] },
): Promise<number> => {
  if (rows.length === 0) {
    return 0;
  }
  const tuples = sql.join(
    rows.map(
      (row) =>
        sql`(${row.id}::uuid, ${row.contentHash}::text, ${row.updatedAtToken}::timestamptz)`,
    ),
    sql`, `,
  );
  // audit: skip — terminal projection state is derived rebuild bookkeeping
  const cleared: unknown = await tx.execute(sql`
    WITH expected(id, content_hash, expected_updated) AS (
      VALUES ${tuples}
    ), live AS MATERIALIZED (
      SELECT d.id, d.content_hash
      FROM ${caseLawDecisions} AS d
      INNER JOIN expected AS v ON v.id = d.id
      WHERE d.content_hash IS NOT DISTINCT FROM v.content_hash
        AND d.updated_at IS NOT DISTINCT FROM v.expected_updated
      FOR UPDATE OF d
    )
    UPDATE ${caseLawCorpusIndexProjections} AS projection
    SET pending_action = null,
        pending_hash = null,
        pending_index_ids = '{}',
        updated_at = now()
    FROM live
    WHERE projection.generation = ${generation}
      AND projection.decision_id = live.id
      AND (
        live.content_hash IS NULL
        OR projection.pending_hash IS NOT DISTINCT FROM live.content_hash
      )
    RETURNING projection.decision_id AS id
  `);
  return resolveMarkedRowIds(cleared, rows).size;
};

const clearDeletedGenerationProjection = async (
  tx: Transaction,
  { generation, row }: { generation: string; row: IndexableRow },
): Promise<void> => {
  // audit: skip — deletion completes derived projection bookkeeping
  await tx.execute(sql`
    WITH live AS MATERIALIZED (
      SELECT d.id
      FROM ${caseLawDecisions} AS d
      WHERE d.id = ${row.id}
        AND d.content_hash IS NULL
        AND d.updated_at IS NOT DISTINCT FROM ${row.updatedAtToken}::timestamptz
      FOR UPDATE OF d
    )
    DELETE FROM ${caseLawCorpusIndexProjections} AS projection
    USING live
    WHERE projection.generation = ${generation}
      AND projection.decision_id = live.id
      AND projection.pending_action IN ('index', 'delete')
  `);
};

const clearIneligibleGenerationProjection = async (
  tx: Transaction,
  { generation, row }: { generation: string; row: GenerationBackfillRow },
): Promise<void> => {
  // The source revision joins the external delete to the exact eligibility
  // observation that caused it. A later descriptor change remains ahead of
  // the durable cursor and will be reconciled as a new revision.
  // audit: skip — source eligibility controls derived projection membership
  await tx.execute(sql`
    WITH live AS MATERIALIZED (
      SELECT d.id
      FROM ${caseLawDecisions} AS d
      INNER JOIN ${caseLawSources} AS source ON source.id = d.source_id
      WHERE d.id = ${row.id}
        AND d.content_hash IS NOT DISTINCT FROM ${row.contentHash}
        AND d.updated_at IS NOT DISTINCT FROM ${row.updatedAtToken}::timestamptz
        AND source.descriptor IS NOT NULL
        AND (source.descriptor ->> 'allowsRedistribution') IS DISTINCT FROM 'true'
      FOR UPDATE OF d, source
    )
    DELETE FROM ${caseLawCorpusIndexProjections} AS projection
    USING live
    WHERE projection.generation = ${generation}
      AND projection.decision_id = live.id
  `);
};

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
  generationProjectionIndexIds: (row) => [
    ...(row.generationIndexId === null ? [] : [row.generationIndexId]),
    ...row.generationPendingIndexIds,
  ],
  markIndexedBatch: async (tx, { rows, indexId, mode, now }) => {
    if (rows.length === 0) {
      return new Set();
    }
    if (mode.type === "generation-rebuild") {
      // Serving-index markers remain untouched, so an overlapping generation
      // cannot hide or invalidate another generation's successful projection.
      return await commitCurrentGenerationProjection(tx, {
        generation: mode.generation,
        indexId,
        rows,
      });
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

export const BACKFILL_STATUS = {
  ADVANCED: "advanced",
  BUSY: "busy",
  COMPLETE: "complete",
} as const;

const BACKFILL_LEASE_MS = 30 * 60 * 1000;

const completeRemoteEffect = async (): Promise<void> => {
  await Promise.resolve();
};

const createRemoteEffectGuard =
  (
    scopedDb: Parameters<typeof indexer.backfill>[0],
    beforeDatabaseMark: GenerationProjectionGuards["beforeDatabaseMark"],
  ): GenerationProjectionGuards["beforeRemoteEffect"] =>
  async ({ effect, onLeaseLost }) => {
    // The durable lease row serializes writers across the remote operation.
    // Renew it in a short transaction, release the connection, then start
    // HTTP/S3 work. Every generation lease uses this boundary so remote I/O
    // cannot accidentally move back inside a database callback.
    await scopedDb(async (tx) => {
      await beforeDatabaseMark(tx);
    });
    const result = await effect();
    // A process can be paused after the pre-effect renewal for longer than
    // the lease. Revalidate in a second short transaction before exposing the
    // result to a caller that could advance a cursor or clear a durable
    // projection target. On failure the pending index/delete target remains
    // replayable, so a late append or delete converges without retaining a
    // stale physical copy.
    try {
      await scopedDb(async (tx) => {
        await beforeDatabaseMark(tx);
      });
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        await onLeaseLost();
        throw new ConcurrentModificationError({
          message:
            "Case-law corpus remote effect completed after its writer lease was lost",
        });
      }
      throw error;
    }
    return result;
  };

export type CaseLawCorpusGenerationLease = GenerationProjectionGuards & {
  release: () => Promise<void>;
};

type AcquireGenerationLeaseOptions = {
  generation: string;
  newLeaseToken?: () => string;
  scopedDb: Parameters<typeof indexer.backfill>[0];
};

/**
 * Claims the single writer slot for a physical generation. Rebuilds,
 * incremental writes, and erasure all cross this boundary, so no operation
 * can make a database mark based on a remote effect another writer invalidated.
 */
export const acquireCaseLawCorpusGenerationLease = async ({
  generation,
  newLeaseToken = () => Bun.randomUUIDv7(),
  scopedDb,
}: AcquireGenerationLeaseOptions): Promise<CaseLawCorpusGenerationLease | null> => {
  const leaseToken = newLeaseToken();
  const claimed = await scopedDb(async (tx) => {
    // audit: skip — this row is ephemeral mutual-exclusion state
    const rows = await tx
      .insert(caseLawCorpusIndexWriterLeases)
      .values({
        generation,
        leaseExpiresAt: nextLeaseExpiry(),
        leaseToken,
      })
      .onConflictDoUpdate({
        target: caseLawCorpusIndexWriterLeases.generation,
        set: {
          leaseExpiresAt: nextLeaseExpiry(),
          leaseToken,
        },
        setWhere: sql`${caseLawCorpusIndexWriterLeases.leaseExpiresAt} IS NULL
          OR ${caseLawCorpusIndexWriterLeases.leaseExpiresAt} <= now()`,
      })
      .returning({ generation: caseLawCorpusIndexWriterLeases.generation });
    return rows.at(0);
  });
  if (!claimed) {
    return null;
  }

  const beforeDatabaseMark = async (tx: Transaction): Promise<void> => {
    // audit: skip — renewal extends ownership without changing domain state
    const renewed = (
      await tx
        .update(caseLawCorpusIndexWriterLeases)
        .set({ leaseExpiresAt: nextLeaseExpiry() })
        .where(
          and(
            eq(caseLawCorpusIndexWriterLeases.generation, generation),
            eq(caseLawCorpusIndexWriterLeases.leaseToken, leaseToken),
            sql`${caseLawCorpusIndexWriterLeases.leaseExpiresAt} > now()`,
          ),
        )
        .returning({ generation: caseLawCorpusIndexWriterLeases.generation })
    ).at(0);
    if (!renewed) {
      throw new ConcurrentModificationError({
        message: "Case-law corpus generation writer lease was lost",
      });
    }
  };

  return {
    beforeDatabaseMark,
    beforeRemoteEffect: createRemoteEffectGuard(scopedDb, beforeDatabaseMark),
    recoverRemoteEffectLeaseLoss: async ({ entityIds, indexId }) =>
      await recoverLostGenerationProjectionEffect(scopedDb, generation, {
        decisionIds: entityIds,
        indexId,
      }),
    release: async () => {
      await scopedDb(async (tx) => {
        // audit: skip — release only the caller's writer lease
        await tx
          .update(caseLawCorpusIndexWriterLeases)
          .set({ leaseExpiresAt: null, leaseToken: null })
          .where(
            and(
              eq(caseLawCorpusIndexWriterLeases.generation, generation),
              eq(caseLawCorpusIndexWriterLeases.leaseToken, leaseToken),
            ),
          );
      });
    },
  };
};

export type CorpusIndexBackfillResult =
  | {
      indexed: number;
      status: typeof BACKFILL_STATUS.ADVANCED;
    }
  | {
      indexed: 0;
      status: typeof BACKFILL_STATUS.BUSY;
    }
  | {
      indexed: 0;
      status: typeof BACKFILL_STATUS.COMPLETE;
    };

const backfillIncrementalCorpusIndex = async (
  scopedDb: Parameters<typeof indexer.backfill>[0],
  batchSize: number,
  generation: string,
  options: { readConcurrency?: number } = {},
): Promise<CorpusIndexBackfillResult> => {
  const lease = await acquireCaseLawCorpusGenerationLease({
    generation,
    scopedDb,
  });
  if (!lease) {
    return { indexed: 0, status: BACKFILL_STATUS.BUSY };
  }
  try {
    const indexed = await indexer.backfillFenced(
      scopedDb,
      batchSize,
      generation,
      {
        beforeDatabaseMark: lease.beforeDatabaseMark,
        beforeRemoteEffect: lease.beforeRemoteEffect,
        recoverRemoteEffectLeaseLoss: lease.recoverRemoteEffectLeaseLoss,
        reserveExternalAppend: reserveGenerationProjectionTargets,
        ...options,
      },
    );
    return indexed > 0
      ? { indexed, status: BACKFILL_STATUS.ADVANCED }
      : { indexed: 0, status: BACKFILL_STATUS.COMPLETE };
  } finally {
    await lease.release();
  }
};

type GenerationBackfillCheckpoint = {
  cursorCreatedAt: Date | null;
  cursorId: SafeId<"caseLawDecision"> | null;
  generation: string;
  snapshotAt: Date;
};

type GenerationBackfillRow = IndexableRow & {
  createdAt: Date;
  generationIndexedHash: string | null;
  sourceDescriptor: CorpusSourceDescriptor | null;
};

type SourceReconciliationCheckpoint = {
  cursorCreatedAt: Date | null;
  cursorId: SafeId<"caseLawDecision"> | null;
  generation: string;
  revision: number;
  sourceId: SafeId<"caseLawSource">;
  upperCreatedAt: Date | null;
  upperId: SafeId<"caseLawDecision"> | null;
};

type GenerationProjectionGuards = {
  beforeDatabaseMark: (tx: Transaction) => Promise<void>;
  beforeRemoteEffect: <T>(effect: FencedRemoteEffect<T>) => Promise<T>;
  recoverRemoteEffectLeaseLoss: (args: {
    entityIds: readonly SafeId<"caseLawDecision">[];
    indexId: string;
  }) => Promise<void>;
};

type GenerationBackfillDependencies = {
  backfillRows: (
    scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
    rows: readonly IndexableRow[],
    generation: string,
    options: GenerationProjectionGuards,
  ) => Promise<number>;
  removeProjection: (
    scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
    args: {
      row: GenerationBackfillRow;
      generation: string;
      options: GenerationProjectionGuards;
    },
  ) => Promise<void>;
  newLeaseToken: () => string;
};

const backfillGenerationRows: GenerationBackfillDependencies["backfillRows"] =
  async (scopedDb, rows, generation, options) =>
    await indexer.backfillRows(scopedDb, [...rows], generation, {
      ...options,
      reserveExternalAppend: reserveGenerationProjectionTargets,
    });

type GenerationProjectionTargetSources = Pick<
  GenerationBackfillRow,
  "generationIndexId" | "generationPendingIndexIds" | "indexedGeneration"
>;

/**
 * Every durable pointer that can name a physical copy for this generation.
 * Keep this as one state-table union: a first rebuild can see a legacy
 * `indexed_generation` before it has ever written a projection row.
 */
export const generationProjectionTargetIds = ({
  generation,
  row,
}: {
  generation: string;
  row: GenerationProjectionTargetSources;
}): Set<string> => {
  const targetIndexIds = new Set(row.generationPendingIndexIds);
  if (row.generationIndexId !== null) {
    targetIndexIds.add(row.generationIndexId);
  }
  if (
    row.indexedGeneration !== null &&
    tryCorpusIndexGeneration(row.indexedGeneration) === generation
  ) {
    targetIndexIds.add(row.indexedGeneration);
  }
  return targetIndexIds;
};

const removeGenerationProjection: GenerationBackfillDependencies["removeProjection"] =
  async (scopedDb, { generation, options, row }) => {
    const targetIndexIds = generationProjectionTargetIds({ generation, row });
    const removals = await Promise.all(
      [...targetIndexIds].map(
        async (targetIndexId) =>
          await indexer.removeFenced({
            beforeRemoteEffect: options.beforeRemoteEffect,
            entityId: row.id,
            indexId: targetIndexId,
            onLeaseLost: async () =>
              await options.recoverRemoteEffectLeaseLoss({
                entityIds: [row.id],
                indexId: targetIndexId,
              }),
            operation: "delete",
            scopedDb,
          }),
      ),
    );
    const failed = removals.find((removed) => removed.isErr());
    if (failed?.isErr()) {
      throw failed.error;
    }
    await scopedDb(async (tx) => {
      await options.beforeDatabaseMark(tx);
      if (row.contentHash === null) {
        await clearDeletedGenerationProjection(tx, { generation, row });
        return;
      }
      await clearIneligibleGenerationProjection(tx, { generation, row });
    });
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

const hasNoNewerRebuild = ({
  checkpoint,
}: {
  checkpoint: GenerationBackfillCheckpoint;
}) => sql`NOT EXISTS (
  SELECT 1 FROM ${caseLawCorpusIndexBackfills} AS newer
  WHERE (newer.snapshot_at, newer.generation) > (${checkpoint.snapshotAt}, ${checkpoint.generation})
)`;

const ownsUnexpiredLease = ({
  checkpoint,
  leaseToken,
  status,
}: {
  checkpoint: GenerationBackfillCheckpoint;
  leaseToken: string;
  status: CaseLawCorpusIndexBackfillStatus;
}) =>
  and(
    eq(caseLawCorpusIndexBackfills.status, status),
    sameCursor({ checkpoint }),
    status === CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING
      ? hasNoNewerRebuild({ checkpoint })
      : sql`true`,
    eq(caseLawCorpusIndexBackfills.leaseToken, leaseToken),
    sql`${caseLawCorpusIndexBackfills.leaseExpiresAt} > now()`,
  );

const selectGenerationBackfillPage = async (
  scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
  {
    batchSize,
    checkpoint,
  }: { batchSize: number; checkpoint: GenerationBackfillCheckpoint },
): Promise<GenerationBackfillRow[]> =>
  await scopedDb((tx) =>
    tx
      .select(GENERATION_PAGE_SELECT_COLUMNS)
      .from(caseLawDecisions)
      .leftJoin(
        caseLawCorpusIndexProjections,
        and(
          eq(caseLawCorpusIndexProjections.decisionId, caseLawDecisions.id),
          eq(caseLawCorpusIndexProjections.generation, checkpoint.generation),
        ),
      )
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

const selectGenerationPendingPage = async (
  scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
  { generation, limit }: { generation: string; limit: number },
): Promise<GenerationBackfillRow[]> =>
  await scopedDb((tx) =>
    tx
      .select(GENERATION_PAGE_SELECT_COLUMNS)
      .from(caseLawCorpusIndexProjections)
      .innerJoin(
        caseLawDecisions,
        eq(caseLawDecisions.id, caseLawCorpusIndexProjections.decisionId),
      )
      .innerJoin(
        caseLawSources,
        eq(caseLawSources.id, caseLawDecisions.sourceId),
      )
      .where(
        and(
          eq(caseLawCorpusIndexProjections.generation, generation),
          isNotNull(caseLawCorpusIndexProjections.pendingAction),
        ),
      )
      .orderBy(asc(caseLawCorpusIndexProjections.decisionId))
      .limit(limit),
  );

const selectGenerationEligibilityPage = async (
  scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
  {
    checkpoint,
    limit,
  }: { checkpoint: SourceReconciliationCheckpoint; limit: number },
): Promise<GenerationBackfillRow[]> =>
  await scopedDb((tx) =>
    tx
      .select(GENERATION_PAGE_SELECT_COLUMNS)
      .from(caseLawDecisions)
      .innerJoin(
        caseLawSources,
        eq(caseLawDecisions.sourceId, caseLawSources.id),
      )
      .leftJoin(
        caseLawCorpusIndexProjections,
        and(
          eq(caseLawCorpusIndexProjections.decisionId, caseLawDecisions.id),
          eq(caseLawCorpusIndexProjections.generation, checkpoint.generation),
        ),
      )
      .where(
        and(
          eq(caseLawDecisions.sourceId, checkpoint.sourceId),
          checkpoint.upperCreatedAt === null
            ? sql`false`
            : sql`(${caseLawDecisions.createdAt}, ${caseLawDecisions.id}) <= (${checkpoint.upperCreatedAt}, ${checkpoint.upperId})`,
          checkpoint.cursorCreatedAt === null
            ? undefined
            : sql`(${caseLawDecisions.createdAt}, ${caseLawDecisions.id}) > (${checkpoint.cursorCreatedAt}, ${checkpoint.cursorId})`,
        ),
      )
      .orderBy(asc(caseLawDecisions.createdAt), asc(caseLawDecisions.id))
      .limit(limit),
  );

const selectSourceReconciliationCheckpoint = async (
  scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
  generation: string,
): Promise<SourceReconciliationCheckpoint | undefined> =>
  await scopedDb(async (tx) =>
    (
      await tx
        .select({
          cursorCreatedAt:
            caseLawCorpusIndexSourceReconciliations.cursorCreatedAt,
          cursorId: caseLawCorpusIndexSourceReconciliations.cursorId,
          generation: caseLawCorpusIndexSourceReconciliations.generation,
          revision: caseLawCorpusIndexSourceReconciliations.revision,
          sourceId: caseLawCorpusIndexSourceReconciliations.sourceId,
          upperCreatedAt:
            caseLawCorpusIndexSourceReconciliations.upperCreatedAt,
          upperId: caseLawCorpusIndexSourceReconciliations.upperId,
        })
        .from(caseLawCorpusIndexSourceReconciliations)
        .where(
          eq(caseLawCorpusIndexSourceReconciliations.generation, generation),
        )
        .orderBy(asc(caseLawCorpusIndexSourceReconciliations.sourceId))
        .limit(1)
    ).at(0),
  );

const hasPendingGenerationProjection = async (
  scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
  generation: string,
): Promise<boolean> =>
  await scopedDb(async (tx) =>
    Boolean(
      (
        await tx
          .select({ decisionId: caseLawCorpusIndexProjections.decisionId })
          .from(caseLawCorpusIndexProjections)
          .where(
            and(
              eq(caseLawCorpusIndexProjections.generation, generation),
              isNotNull(caseLawCorpusIndexProjections.pendingAction),
            ),
          )
          .limit(1)
      ).at(0),
    ),
  );

const hasGenerationCheckpoint = async (
  scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
  generation: string,
): Promise<boolean> =>
  await scopedDb(async (tx) =>
    Boolean(
      (
        await tx
          .select({ generation: caseLawCorpusIndexBackfills.generation })
          .from(caseLawCorpusIndexBackfills)
          .where(eq(caseLawCorpusIndexBackfills.generation, generation))
          .limit(1)
      ).at(0),
    ),
  );

const validateGenerationBoundary = (generation: string): void => {
  if (!isCorpusIndexGeneration(generation)) {
    throw new CorpusIndexError({
      message: "Invalid corpus index generation",
    });
  }
};

const sameSourceReconciliation = (checkpoint: SourceReconciliationCheckpoint) =>
  and(
    eq(
      caseLawCorpusIndexSourceReconciliations.generation,
      checkpoint.generation,
    ),
    eq(caseLawCorpusIndexSourceReconciliations.sourceId, checkpoint.sourceId),
    eq(caseLawCorpusIndexSourceReconciliations.revision, checkpoint.revision),
    sql`${caseLawCorpusIndexSourceReconciliations.cursorCreatedAt} IS NOT DISTINCT FROM ${checkpoint.cursorCreatedAt}`,
    sql`${caseLawCorpusIndexSourceReconciliations.cursorId} IS NOT DISTINCT FROM ${checkpoint.cursorId}`,
    sql`${caseLawCorpusIndexSourceReconciliations.upperCreatedAt} IS NOT DISTINCT FROM ${checkpoint.upperCreatedAt}`,
    sql`${caseLawCorpusIndexSourceReconciliations.upperId} IS NOT DISTINCT FROM ${checkpoint.upperId}`,
  );

const isCorpusEligible = (row: GenerationBackfillRow): boolean =>
  row.contentHash !== null && isRedistributable(row.sourceDescriptor);

const isEligibleForGeneration = (
  row: GenerationBackfillRow,
  generation: string,
): boolean =>
  isCorpusEligible(row) &&
  (row.generationIndexId !== corpusIndexId(generation, row.country) ||
    row.generationIndexedHash !== row.contentHash ||
    row.generationPendingAction !== null);

const withoutSourceDescriptor = ({
  sourceDescriptor: _sourceDescriptor,
  generationIndexedHash: _generationIndexedHash,
  ...row
}: GenerationBackfillRow): IndexableRow => row;

/**
 * Creates the case-law generation-rebuild runner. Its explicit dependencies
 * make the state machine deterministic in database tests while production
 * retains the shared indexer's normal S3, CAS, and audit path.
 */
export const createCaseLawGenerationBackfill =
  ({
    backfillRows,
    newLeaseToken,
    removeProjection,
  }: GenerationBackfillDependencies) =>
  async (
    scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
    batchSize: number,
    generation: string,
  ): Promise<CorpusIndexBackfillResult> => {
    validateGenerationBoundary(generation);
    const writerLease = await acquireCaseLawCorpusGenerationLease({
      generation,
      newLeaseToken,
      scopedDb,
    });
    if (!writerLease) {
      return { indexed: 0, status: BACKFILL_STATUS.BUSY };
    }
    try {
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
        await tx.execute(
          sql`LOCK TABLE ${caseLawDecisions}, ${caseLawSources} IN SHARE MODE`,
        );
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

      type LeaseGuardOptions = {
        checkpoint: GenerationBackfillCheckpoint;
        leaseToken: string;
        status: CaseLawCorpusIndexBackfillStatus;
      };
      const createLeaseGuards = ({
        checkpoint: ownedCheckpoint,
        leaseToken,
        status,
      }: LeaseGuardOptions) => {
        const beforeDatabaseMark = async (tx: Transaction): Promise<void> => {
          await writerLease.beforeDatabaseMark(tx);
          // audit: skip — renewal extends ephemeral ownership without changing rebuild progress
          const renewed = (
            await tx
              .update(caseLawCorpusIndexBackfills)
              .set({ leaseExpiresAt: nextLeaseExpiry() })
              .where(
                and(
                  eq(caseLawCorpusIndexBackfills.generation, generation),
                  ownsUnexpiredLease({
                    checkpoint: ownedCheckpoint,
                    leaseToken,
                    status,
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
        const beforeRemoteEffect = createRemoteEffectGuard(
          scopedDb,
          beforeDatabaseMark,
        );
        return {
          beforeDatabaseMark,
          beforeRemoteEffect,
          recoverRemoteEffectLeaseLoss:
            writerLease.recoverRemoteEffectLeaseLoss,
        };
      };

      const releaseLease = async ({
        leaseToken,
        status,
      }: Pick<LeaseGuardOptions, "leaseToken" | "status">): Promise<void> => {
        await scopedDb(async (tx) => {
          // audit: skip — release only the caller's durable lease
          await tx
            .update(caseLawCorpusIndexBackfills)
            .set({ leaseExpiresAt: null, leaseToken: null })
            .where(
              and(
                eq(caseLawCorpusIndexBackfills.generation, generation),
                eq(caseLawCorpusIndexBackfills.status, status),
                eq(caseLawCorpusIndexBackfills.leaseToken, leaseToken),
              ),
            );
        });
      };

      const reconcilePending = async ({
        checkpoint: ownedCheckpoint,
        leaseToken,
        status,
      }: LeaseGuardOptions): Promise<CorpusIndexBackfillResult> => {
        const guards = createLeaseGuards({
          checkpoint: ownedCheckpoint,
          leaseToken,
          status,
        });
        await guards.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: async () => await Promise.resolve(),
        });
        const sourceCheckpoint = await selectSourceReconciliationCheckpoint(
          scopedDb,
          generation,
        );
        if (sourceCheckpoint) {
          const sourcePage = await selectGenerationEligibilityPage(scopedDb, {
            checkpoint: sourceCheckpoint,
            limit: batchSize,
          });
          const lastSourceRow = sourcePage.at(-1);
          if (!lastSourceRow) {
            const removed = await scopedDb(async (tx) => {
              await guards.beforeDatabaseMark(tx);
              // audit: skip — deleting a drained revision is its durable completion marker
              const rows = await tx
                .delete(caseLawCorpusIndexSourceReconciliations)
                .where(sameSourceReconciliation(sourceCheckpoint))
                .returning({
                  sourceId: caseLawCorpusIndexSourceReconciliations.sourceId,
                });
              return rows.at(0);
            });
            return removed
              ? { indexed: 0, status: BACKFILL_STATUS.ADVANCED }
              : { indexed: 0, status: BACKFILL_STATUS.BUSY };
          }

          // The source revision is authoritative even when the projection
          // still looks current: a prior ineligible delete may have removed
          // the remote documents and then lost its database CAS to this
          // revision. Replacing every eligible row makes that race converge.
          const eligible = sourcePage
            .filter(isCorpusEligible)
            .map(withoutSourceDescriptor);
          const indexed =
            eligible.length === 0
              ? 0
              : await backfillRows(scopedDb, eligible, generation, guards);
          if (indexed !== eligible.length) {
            throw new CorpusIndexError({
              message:
                "source eligibility reconciliation did not reach a fixed point",
            });
          }
          const removals = sourcePage.filter(
            (row) =>
              !isCorpusEligible(row) &&
              (row.generationIndexId !== null ||
                row.generationPendingIndexIds.length > 0),
          );
          await Promise.all(
            removals.map(async (row) => {
              await removeProjection(scopedDb, {
                generation,
                options: guards,
                row,
              });
            }),
          );

          const advanced = await scopedDb(async (tx) => {
            await guards.beforeDatabaseMark(tx);
            // audit: skip — the revision-scoped keyset cursor is durable reconciliation progress
            const rows = await tx
              .update(caseLawCorpusIndexSourceReconciliations)
              .set({
                cursorCreatedAt: lastSourceRow.createdAt,
                cursorId: lastSourceRow.id,
                updatedAt: sql`now()`,
              })
              .where(sameSourceReconciliation(sourceCheckpoint))
              .returning({
                sourceId: caseLawCorpusIndexSourceReconciliations.sourceId,
              });
            return rows.at(0);
          });
          return advanced
            ? { indexed, status: BACKFILL_STATUS.ADVANCED }
            : { indexed: 0, status: BACKFILL_STATUS.BUSY };
        }

        const pendingPage = await selectGenerationPendingPage(scopedDb, {
          generation,
          limit: batchSize,
        });
        if (pendingPage.length === 0) {
          return { indexed: 0, status: BACKFILL_STATUS.COMPLETE };
        }

        const pendingIndexRows: GenerationBackfillRow[] = [];
        const pendingDeleteRows: GenerationBackfillRow[] = [];
        for (const row of pendingPage) {
          switch (row.generationPendingAction) {
            case "index":
              pendingIndexRows.push(row);
              break;
            case "delete":
              pendingDeleteRows.push(row);
              break;
            case null:
              return panic("selected corpus projection has no pending action");
            default: {
              const unhandled: never = row.generationPendingAction;
              panic(`Unhandled corpus projection action: ${String(unhandled)}`);
            }
          }
        }
        const eligible = pendingIndexRows
          .filter(isCorpusEligible)
          .map(withoutSourceDescriptor);
        const terminal = pendingIndexRows
          .filter(
            (row) =>
              !isCorpusEligible(row) &&
              row.generationIndexId === null &&
              row.generationPendingIndexIds.length === 0,
          )
          .map(withoutSourceDescriptor);
        const terminalDeletes = pendingIndexRows.filter(
          (row) =>
            !isCorpusEligible(row) &&
            (row.generationIndexId !== null ||
              row.generationPendingIndexIds.length > 0),
        );
        const indexed =
          eligible.length === 0
            ? 0
            : await backfillRows(scopedDb, eligible, generation, guards);
        if (indexed !== eligible.length) {
          throw new CorpusIndexError({
            message: "generation reconciliation did not reach a fixed point",
          });
        }
        if (terminal.length > 0) {
          const cleared = await scopedDb(async (tx) => {
            await guards.beforeDatabaseMark(tx);
            return await clearTerminalGenerationPending(tx, {
              generation,
              rows: terminal,
            });
          });
          if (cleared !== terminal.length) {
            throw new CorpusIndexError({
              message:
                "terminal generation reconciliation did not reach a fixed point",
            });
          }
        }
        for (const row of [...pendingDeleteRows, ...terminalDeletes]) {
          // oxlint-disable-next-line no-await-in-loop -- one durable deletion action owns one remote delete and fenced state transition
          await removeProjection(scopedDb, {
            generation,
            options: guards,
            row,
          });
        }
        return { indexed, status: BACKFILL_STATUS.ADVANCED };
      };

      if (
        checkpoint.status === CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE
      ) {
        const reconciliationToken = newLeaseToken();
        const claimedReconciliation = await scopedDb(async (tx) => {
          // audit: skip — completed rebuild reconciliation uses the durable lease for mutual exclusion
          const claimedRows = await tx
            .update(caseLawCorpusIndexBackfills)
            .set({
              leaseExpiresAt: nextLeaseExpiry(),
              leaseToken: reconciliationToken,
            })
            .where(
              and(
                eq(caseLawCorpusIndexBackfills.generation, generation),
                eq(
                  caseLawCorpusIndexBackfills.status,
                  CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
                ),
                sameCursor({ checkpoint }),
                or(
                  isNull(caseLawCorpusIndexBackfills.leaseExpiresAt),
                  lte(caseLawCorpusIndexBackfills.leaseExpiresAt, sql`now()`),
                ),
              ),
            )
            .returning();
          return claimedRows.at(0);
        });
        if (!claimedReconciliation) {
          return { indexed: 0, status: BACKFILL_STATUS.BUSY };
        }
        const reconciliationCheckpoint: GenerationBackfillCheckpoint = {
          cursorCreatedAt: claimedReconciliation.cursorCreatedAt,
          cursorId: claimedReconciliation.cursorId,
          generation: claimedReconciliation.generation,
          snapshotAt: claimedReconciliation.snapshotAt,
        };
        try {
          return await reconcilePending({
            checkpoint: reconciliationCheckpoint,
            leaseToken: reconciliationToken,
            status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
          });
        } finally {
          await releaseLease({
            leaseToken: reconciliationToken,
            status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
          });
        }
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
              hasNoNewerRebuild({ checkpoint }),
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
      const runningGuards = createLeaseGuards({
        checkpoint: claimedCheckpoint,
        leaseToken,
        status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
      });
      await runningGuards.beforeRemoteEffect({
        effect: completeRemoteEffect,
        onLeaseLost: async () => await Promise.resolve(),
      });
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
              status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
            })
            .where(
              and(
                eq(caseLawCorpusIndexBackfills.generation, generation),
                ownsUnexpiredLease({
                  checkpoint: claimedCheckpoint,
                  leaseToken,
                  status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
                }),
              ),
            )
            .returning();
          return rows.at(0);
        });
        if (!completed) {
          return { indexed: 0, status: BACKFILL_STATUS.BUSY };
        }
        const completedCheckpoint: GenerationBackfillCheckpoint = {
          cursorCreatedAt: completed.cursorCreatedAt,
          cursorId: completed.cursorId,
          generation: completed.generation,
          snapshotAt: completed.snapshotAt,
        };
        try {
          return await reconcilePending({
            checkpoint: completedCheckpoint,
            leaseToken,
            status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
          });
        } finally {
          await releaseLease({
            leaseToken,
            status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
          });
        }
      }

      const rows = page
        .filter((row) => isEligibleForGeneration(row, generation))
        .map(withoutSourceDescriptor);
      let indexed: number;
      try {
        indexed = await backfillRows(scopedDb, rows, generation, runningGuards);
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
                  status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
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
                status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
              }),
            ),
          )
          .returning({ generation: caseLawCorpusIndexBackfills.generation });
        return advancedRows.at(0);
      });
      return advanced
        ? { indexed, status: BACKFILL_STATUS.ADVANCED }
        : { indexed: 0, status: BACKFILL_STATUS.BUSY };
    } finally {
      await writerLease.release();
    }
  };

/**
 * Advance one durable generation-rebuild page. The page is bounded by the
 * `(created_at,id)` cursor before any generation comparison is made, so a
 * cutover never turns into a table scan.
 */
export const backfillCorpusIndexGenerationPage =
  createCaseLawGenerationBackfill({
    backfillRows: backfillGenerationRows,
    newLeaseToken: () => Bun.randomUUIDv7(),
    removeProjection: removeGenerationProjection,
  });

export const backfillCorpusIndex = async (
  scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
  batchSize: number,
  generation: string,
  options: { readConcurrency?: number } = {},
): Promise<CorpusIndexBackfillResult> => {
  validateGenerationBoundary(generation);
  const [sourceReconciliation, pendingProjection, checkpoint] =
    await Promise.all([
      selectSourceReconciliationCheckpoint(scopedDb, generation),
      hasPendingGenerationProjection(scopedDb, generation),
      hasGenerationCheckpoint(scopedDb, generation),
    ]);
  // A serving generation without a checkpoint has no durable projection
  // targets yet. Start its bounded snapshot first; inventing a synthetic
  // completed checkpoint would suppress that replay and leave future appends
  // without a crash-recoverable target record.
  if (!checkpoint || sourceReconciliation || pendingProjection) {
    const result = await backfillCorpusIndexGenerationPage(
      scopedDb,
      batchSize,
      generation,
    );
    return result;
  }
  return await backfillIncrementalCorpusIndex(
    scopedDb,
    batchSize,
    generation,
    options,
  );
};
export const removeDecisionFromCorpusIndex = indexer.removeFenced;
