import { panic, Result } from "better-result";
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCorpusIndexBackfills,
  caseLawCorpusIndexDeleteWatermarks,
  caseLawCorpusIndexPendingDeletes,
  caseLawCorpusIndexProjections,
  caseLawCorpusIndexSourceReconciliations,
  caseLawCorpusIndexWriterLeases,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS,
  type CaseLawCorpusIndexBackfillStatus,
  type CaseLawCorpusIndexProjectionAction,
  caseLawIndexJobs,
  caseLawSources,
} from "@/api/db/schema";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import type { SafeId } from "@/api/lib/branded-types";
import {
  redistributableCaseLawSource,
  redistributableCaseLawSourceSqlFor,
} from "@/api/lib/case-law/redistribution";
import type { CorpusChunk } from "@/api/lib/corpus-index/chunking";
import {
  chunkDocument,
  formatHeadingPath,
} from "@/api/lib/corpus-index/chunking";
import type {
  CorpusBackfillOutcome,
  CorpusBackfillTiming,
  CorpusDocumentPayload,
  CorpusIndexAdapter,
  FencedRemoteEffect,
  ReservedAppendTargets,
} from "@/api/lib/corpus-index/core";
import {
  createCorpusIndexer,
  FENCED_BACKFILL_BATCH_STATUS,
  resolveMarkedRowIds,
  resolveReservedAppendTargets,
  settleAll,
} from "@/api/lib/corpus-index/core";
import {
  timestampCasToken,
  type TimestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import { errorSystemFields } from "@/api/lib/errors/utils";
import { caseLawDecisionCorpusIndexIdSql } from "@/api/lib/legal-search/case-law-corpus-projection";
import { caseLawIndexIdSql } from "@/api/lib/legal-search/case-law-index-groups";
import {
  CORPUS_INDEX_COMMIT,
  CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexCommitMode } from "@/api/lib/legal-search/corpus-index-client";
import {
  DECISION_TIMESTAMP_FIELD,
  UNDATED_DECISION_TIMESTAMP,
} from "@/api/lib/legal-search/corpus-index-config";
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
  isCaseLawCorpusGeneration,
  isCorpusIndexGeneration,
  isCorpusIndexJurisdiction,
  tryCorpusIndexGeneration,
} from "@/api/lib/legal-search/index-naming";
import { logger } from "@/api/lib/observability/logger";

/**
 * corpus index search-projection maintenance for the `case_law` family.
 * Domain adapter over the shared core (lib/corpus-index/core.ts): supplies the
 * case-law tables, batch queries, and per-decision document shape; the core
 * owns the S3-chunked load, per-group ingest, compare-and-set commit, and audit
 * trail (case_law_index_jobs). Physical indexes are named by `corpusIndexId`
 * (per jurisdiction, or per index group from generation 3 on), with the
 * license gate in SQL so non-redistributable sources never enter the scan.
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
  identifiers: string[];
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
  generationPendingRevision: number;
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
  identifiers: sql<string[]>`ARRAY(
    SELECT identifier.value
    FROM ${caseLawDecisionIdentifiers} identifier
    WHERE identifier.decision_id = ${caseLawDecisions.id}
    ORDER BY identifier.type, identifier.value
  )`,
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
  generationPendingRevision: sql<number>`0`,
  createdAtToken: timestampCasToken(caseLawDecisions.createdAt),
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
  generationPendingRevision: sql<number>`coalesce(${caseLawCorpusIndexProjections.pendingRevision}, 0)`,
  sourceDescriptor: caseLawSources.descriptor,
};

const INCREMENTAL_SELECT_COLUMNS = {
  ...SELECT_COLUMNS,
  generationIndexId: caseLawCorpusIndexProjections.indexId,
  generationPendingAction: caseLawCorpusIndexProjections.pendingAction,
  generationPendingIndexIds: sql<
    string[]
  >`coalesce(${caseLawCorpusIndexProjections.pendingIndexIds}, '{}'::varchar(64)[])`,
  generationPendingRevision: sql<number>`coalesce(${caseLawCorpusIndexProjections.pendingRevision}, 0)`,
};

// A row is indexable once its canonical payload is in object storage.
const hasContent = sql`${caseLawDecisions.contentHash} IS NOT NULL`;
const hasCorpusJurisdiction = sql`${caseLawDecisions.country} ~ '^[A-Za-z]{2,8}$'`;

/**
 * Whether this generation still needs the row's current content.
 *
 * `case_law_decisions.indexed_hash` and the generation projection's
 * `indexed_hash` both record "what of this row is in the engine", and a
 * generation rebuild commits only the projection: it leaves the serving marker
 * null. Selecting on the serving marker alone therefore re-indexes every row
 * the rebuild already placed, which is a no-op against the engine and costs a
 * corpus read, a delete task and an ingest apiece.
 *
 * A row with no projection row reads null here and still selects, as does one
 * whose content moved past what the projection committed. A queued action also
 * selects: metadata-only refreshes retain the content hash but still need to
 * replace the generation's document.
 */
const projectionNeedsCurrentContent = sql`(
  ${caseLawCorpusIndexProjections.indexedHash} IS DISTINCT FROM ${caseLawDecisions.contentHash}
  OR ${caseLawCorpusIndexProjections.pendingAction} IS NOT NULL
)`;

const settleReservedGenerationProjections = async (
  tx: Transaction,
  {
    generation,
    marked,
    reservations,
    rows,
  }: {
    generation: string;
    marked: ReadonlySet<SafeId<"caseLawDecision">>;
    reservations: ReadonlyMap<SafeId<"caseLawDecision">, ReservedAppendTargets>;
    rows: readonly IndexableRow[];
  },
): Promise<void> => {
  const markedRows = rows.filter(({ id }) => marked.has(id));
  if (markedRows.length === 0) {
    return;
  }
  const tuples = sql.join(
    markedRows.map((row) => {
      const reservation = reservations.get(row.id);
      if (reservation === undefined) {
        panic("marked corpus row has no reservation epoch");
      }
      return sql`(${row.id}::uuid, ${row.contentHash}::text, ${reservation.revision}::integer)`;
    }),
    sql`, `,
  );
  // Only the exact reservation epoch whose targets were deleted may settle.
  // A lease-loss compensation or refresh increments the revision, preserving
  // every target it adds after this operation's cleanup snapshot.
  // audit: skip — search index maintenance; rebuilds derived state
  await tx.execute(sql`
    WITH settled(decision_id, content_hash, pending_revision) AS (
      VALUES ${tuples}
    )
    UPDATE ${caseLawCorpusIndexProjections} AS projection
    SET pending_action = null,
        pending_hash = null,
        pending_index_ids = '{}',
        updated_at = now()
    FROM settled
    WHERE projection.generation = ${generation}
      AND projection.decision_id = settled.decision_id
      AND projection.pending_hash IS NOT DISTINCT FROM settled.content_hash
      AND projection.pending_revision = settled.pending_revision
  `);
};

const commitCurrentGenerationProjection = async (
  tx: Transaction,
  {
    generation,
    indexId,
    reservations,
    rows,
  }: {
    generation: string;
    indexId: string;
    reservations: ReadonlyMap<SafeId<"caseLawDecision">, ReservedAppendTargets>;
    rows: readonly IndexableRow[];
  },
): Promise<Set<SafeId<"caseLawDecision">>> => {
  if (rows.length === 0) {
    return new Set();
  }
  const tuples = sql.join(
    rows.map((row) => {
      const reservation = reservations.get(row.id);
      if (reservation === undefined) {
        panic("generation commit has no reservation epoch");
      }
      return sql`(${row.id}::uuid, ${row.contentHash}::text, ${reservation.revision}::integer, ${row.updatedAtToken}::timestamptz)`;
    }),
    sql`, `,
  );
  // The generation queue is the commit marker for a rebuild. Locking the
  // decision rows makes the content/update-token check atomic with queue
  // removal; a refresh that races this commit waits, then re-enqueues its
  // newer hash after the transaction releases the row lock.
  // audit: skip — search index maintenance; rebuilds derived state
  const marked: unknown = await tx.execute(sql`
    WITH expected(id, content_hash, pending_revision, expected_updated) AS (
      VALUES ${tuples}
    ), live AS MATERIALIZED (
      SELECT d.id, d.content_hash, v.pending_revision
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
        pending_revision,
        updated_at
      )
      SELECT ${generation}, live.id, ${indexId}, live.content_hash, null, null, '{}', live.pending_revision, now()
      FROM live
      ON CONFLICT (generation, decision_id) DO UPDATE
      SET index_id = EXCLUDED.index_id,
          indexed_hash = EXCLUDED.indexed_hash,
          updated_at = EXCLUDED.updated_at
      RETURNING decision_id
    )
    SELECT live.id FROM live
  `);
  const markedIds = resolveMarkedRowIds(marked, rows);
  await settleReservedGenerationProjections(tx, {
    generation,
    marked: markedIds,
    reservations,
    rows,
  });
  return markedIds;
};

export const reserveGenerationProjectionTargets = async (
  tx: Transaction,
  { generation, rows }: { generation: string; rows: readonly IndexableRow[] },
): Promise<Map<SafeId<"caseLawDecision">, ReservedAppendTargets>> => {
  if (rows.length === 0) {
    return new Map();
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
      INNER JOIN ${caseLawSources} AS source ON source.id = d.source_id
      WHERE d.content_hash IS NOT DISTINCT FROM v.content_hash
        AND d.country = v.country
        AND d.updated_at IS NOT DISTINCT FROM v.expected_updated
        AND d.content_hash IS NOT NULL
        AND d.country ~ '^[A-Za-z]{2,8}$'
        AND ${sql.raw(redistributableCaseLawSourceSqlFor("source"))}
      FOR UPDATE OF d, source
    ), prior AS (
      -- Read under the decision row locks taken in "live": whether an
      -- earlier reservation ever crossed the append boundary, or a
      -- committed copy exists. The trigger seeds projections without
      -- either marker, so their absence proves nothing has reached the
      -- engine for this row.
      SELECT projection.decision_id,
             (projection.append_reserved_at IS NOT NULL
               OR projection.index_id IS NOT NULL) AS may_have_copy
      FROM ${caseLawCorpusIndexProjections} AS projection
      INNER JOIN live ON live.id = projection.decision_id
      WHERE projection.generation = ${generation}
    ), queued AS (
      INSERT INTO ${caseLawCorpusIndexProjections} AS projection (
        generation,
        decision_id,
        pending_action,
        pending_hash,
        pending_index_ids,
        pending_revision,
        append_reserved_at,
        updated_at
      )
      SELECT ${generation}, live.id, 'index', live.content_hash, ARRAY[live.index_id], 1, now(), now()
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
          pending_revision = projection.pending_revision + 1,
          append_reserved_at = EXCLUDED.append_reserved_at,
          updated_at = EXCLUDED.updated_at
      RETURNING decision_id, pending_index_ids, pending_revision
    )
    SELECT queued.decision_id AS id,
           queued.pending_index_ids AS "pendingIndexIds",
           queued.pending_revision AS "pendingRevision",
           COALESCE(prior.may_have_copy, false) AS "mayHaveCopy"
    FROM queued
    LEFT JOIN prior ON prior.decision_id = queued.decision_id
  `);
  return resolveReservedAppendTargets(reserved, rows);
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
        pending_revision,
        updated_at
      )
      SELECT ${generation}, decision.id,
             CASE WHEN decision.content_hash IS NULL THEN 'delete' ELSE 'index' END,
             decision.content_hash,
             ARRAY(
               SELECT DISTINCT target
               FROM unnest(ARRAY[
                 ${indexId},
                 ${caseLawIndexIdSql(sql`${generation}`, sql.raw("decision.country"))}
               ]) AS target
             ), 1, now()
      FROM ${caseLawDecisions} AS decision
      WHERE decision.id IN (${ids})
      ON CONFLICT (generation, decision_id) DO UPDATE
      SET pending_action = EXCLUDED.pending_action,
          pending_hash = EXCLUDED.pending_hash,
          pending_index_ids = ARRAY(
            SELECT DISTINCT target
            FROM unnest(
              projection.pending_index_ids || EXCLUDED.pending_index_ids
            ) AS target
          ),
          pending_revision = projection.pending_revision + 1,
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
        sql`(${row.id}::uuid, ${row.contentHash}::text, ${row.generationPendingRevision}::integer, ${row.updatedAtToken}::timestamptz)`,
    ),
    sql`, `,
  );
  // audit: skip — terminal projection state is derived rebuild bookkeeping
  const cleared: unknown = await tx.execute(sql`
    WITH expected(id, content_hash, pending_revision, expected_updated) AS (
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
      AND projection.pending_revision = (
        SELECT expected.pending_revision
        FROM expected
        WHERE expected.id = live.id
      )
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
      AND projection.pending_revision = ${row.generationPendingRevision}
      AND projection.pending_action IN ('index', 'delete')
  `);
};

/** Exported for the database-backed eligibility lifecycle invariant. */
export const clearIneligibleGenerationProjection = async (
  tx: Transaction,
  {
    generation,
    row,
  }: {
    generation: string;
    row: {
      id: SafeId<"caseLawDecision">;
      contentHash: string | null;
      generationPendingRevision: number;
      updatedAtToken: TimestampCasToken;
    };
  },
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
    UPDATE ${caseLawCorpusIndexProjections} AS projection
    SET index_id = null,
        indexed_hash = null,
        pending_action = null,
        pending_hash = null,
        pending_index_ids = '{}',
        updated_at = now()
    FROM live
    WHERE projection.generation = ${generation}
      AND projection.decision_id = live.id
      AND projection.pending_revision = ${row.generationPendingRevision}
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
  const doc: Record<string, unknown> = {
    document_id: row.id,
    jurisdiction: row.country,
    source: row.sourceId,
    // The docket as its own field, so an exact lookup does not have to go
    // through `title`, where it is folded and tokenized with the court name.
    case_number: row.caseNumber,
    court: row.court,
    language: row.language,
    citation_authority: row.citationAuthority,
    citation_count: row.citationCount,
  };
  if (row.decisionType !== null) {
    doc["document_type"] = row.decisionType;
  }
  // The index's timestamp field, written on every document because the engine
  // requires it on every document: a decision the source published without a
  // date is still indexed, standing in at the sentinel. `decision_date` and
  // `year` stay absent for it, so display and the year facet keep telling the
  // truth about what the court published.
  doc[DECISION_TIMESTAMP_FIELD] =
    row.decisionDate ?? UNDATED_DECISION_TIMESTAMP;
  if (row.decisionDate !== null) {
    doc["decision_date"] = row.decisionDate;
    doc["year"] = Number(row.decisionDate.slice(0, 4));
  }
  if (row.ecli !== null) {
    doc["ecli"] = row.ecli;
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
  const identifierTitle =
    row.identifiers.length > 0 ? row.identifiers.join(" · ") : row.caseNumber;
  const title = `${identifierTitle} — ${row.court}`;
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
  selectMissing: async (scopedDb, { generation, limit }) => {
    // Hash-null rows are the durable pending set: new rows and every refresh
    // clear this field while retaining the old generation pointer needed to
    // delete a moved jurisdiction copy. The partial index keeps this bounded.
    const fresh = await scopedDb((tx) =>
      tx
        .select(INCREMENTAL_SELECT_COLUMNS)
        .from(caseLawDecisions)
        .leftJoin(
          caseLawCorpusIndexProjections,
          and(
            eq(caseLawCorpusIndexProjections.decisionId, caseLawDecisions.id),
            eq(caseLawCorpusIndexProjections.generation, generation),
          ),
        )
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            hasContent,
            hasCorpusJurisdiction,
            redistributableCaseLawSource,
            isNull(caseLawDecisions.indexedHash),
            projectionNeedsCurrentContent,
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
        .select(INCREMENTAL_SELECT_COLUMNS)
        .from(caseLawDecisions)
        .leftJoin(
          caseLawCorpusIndexProjections,
          and(
            eq(caseLawCorpusIndexProjections.decisionId, caseLawDecisions.id),
            eq(caseLawCorpusIndexProjections.generation, generation),
          ),
        )
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(
          and(
            hasContent,
            hasCorpusJurisdiction,
            redistributableCaseLawSource,
            isNotNull(caseLawDecisions.indexedHash),
            sql`${caseLawDecisions.indexedGeneration} = (${caseLawDecisionCorpusIndexIdSql(generation)})`,
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
        reservations: mode.reservations,
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
    const markedIds = resolveMarkedRowIds(marked, rows);
    if (mode.type === "fenced-incremental") {
      await settleReservedGenerationProjections(tx, {
        generation: mode.generation,
        marked: markedIds,
        reservations: mode.reservations,
        rows,
      });
    }
    return markedIds;
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
  recordDeleteJobs: async (scopedDb, { indexId, jobs, opstamp }) => {
    if (jobs.length === 0) {
      return;
    }
    await scopedDb(async (tx) => {
      // audit: skip — append-only index-job rows ARE the indexing audit trail
      await tx.insert(caseLawIndexJobs).values(
        jobs.map((job) => ({
          decisionId: job.entityId,
          generation: indexId,
          operation: job.operation,
          status: job.status,
          contentHash: job.contentHash,
          errorMessage: job.errorMessage ?? null,
        })),
      );
      if (opstamp === null) {
        return;
      }
      // audit: skip — derived engine-settlement watermark; the job rows above
      // are the document-level audit trail for the same remote effect
      await tx
        .insert(caseLawCorpusIndexDeleteWatermarks)
        .values({ indexId, opstamp })
        .onConflictDoUpdate({
          target: caseLawCorpusIndexDeleteWatermarks.indexId,
          set: {
            opstamp: sql`GREATEST(${caseLawCorpusIndexDeleteWatermarks.opstamp}, excluded.opstamp)`,
            updatedAt: new Date(),
          },
        });
      // audit: skip — bounded settlement state; append-only index jobs above
      // remain the audit trail after settled rows are removed by census
      await tx
        .insert(caseLawCorpusIndexPendingDeletes)
        .values(
          jobs.map((job) => ({
            indexId,
            decisionId: job.entityId,
            opstamp,
          })),
        )
        .onConflictDoUpdate({
          target: [
            caseLawCorpusIndexPendingDeletes.indexId,
            caseLawCorpusIndexPendingDeletes.decisionId,
          ],
          set: {
            opstamp: sql`GREATEST(${caseLawCorpusIndexPendingDeletes.opstamp}, excluded.opstamp)`,
          },
        });
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
  if (!isCorpusIndexGeneration(generation)) {
    throw new CorpusIndexError({
      message: "Invalid corpus index generation",
    });
  }
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
    recoverRemoteEffectLeaseLoss: isCaseLawCorpusGeneration(generation)
      ? async ({ entityIds, indexId }) =>
          await recoverLostGenerationProjectionEffect(scopedDb, generation, {
            decisionIds: entityIds,
            indexId,
          })
      : completeRemoteEffect,
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
    const result = await indexer.backfillFenced(
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
    switch (result.status) {
      case FENCED_BACKFILL_BATCH_STATUS.ADVANCED:
        return { indexed: result.indexed, status: BACKFILL_STATUS.ADVANCED };
      case FENCED_BACKFILL_BATCH_STATUS.RETRY:
        return { indexed: 0, status: BACKFILL_STATUS.BUSY };
      case FENCED_BACKFILL_BATCH_STATUS.COMPLETE:
        return { indexed: 0, status: BACKFILL_STATUS.COMPLETE };
      default:
        return result satisfies never;
    }
  } finally {
    await lease.release();
  }
};

/**
 * The order the snapshot walk visits its rows in, and the order the engine
 * receives their documents in: by decision date, undated decisions first.
 *
 * A split's timestamp range spans everything written into it, so the walk's
 * order is what decides whether a date-filtered query can skip a split or has
 * to open it. Walking by decision date gives each split a contiguous span of
 * dates; walking by anything else gives every split the corpus' whole range.
 *
 * `coalesce(..., '-infinity')` rather than a null-placement rule: the walk key
 * is then never null, so one row comparison expresses the whole cursor and the
 * page stays a single index range. Undated decisions sort first, which is
 * where the documents written for them belong — they carry the earliest
 * timestamp the mapping can hold.
 *
 * What this orders is the snapshot walk, which is the whole corpus. It does
 * not order the pending queue: that drains before each page, in decision-id
 * order, and its documents carry whatever dates live traffic corrected or
 * ingested. Those widen the split they land in, bounded by the commit that
 * publishes them. Holding them back until the rebuild finished is the wedge
 * the drain exists to prevent, so the banding is a property of the rebuild's
 * own pages, not of every document the generation ever receives.
 */
const NEGATIVE_INFINITY_DATE = "-infinity";

// Inlined rather than bound: the planner matches an expression index by the
// expression, and a bind parameter is not the constant the index was built on.
const walkDate = sql`coalesce(${caseLawDecisions.decisionDate}, ${sql.raw(
  `'${NEGATIVE_INFINITY_DATE}'`,
)}::date)`;

/**
 * Where the walk stopped. A `date` is day-granular and round-trips exactly, so
 * unlike a timestamp cursor it cannot be truncated into re-selecting its own
 * row; what it does leave is large tie groups, which `id` orders.
 */
type GenerationWalkCursor = {
  id: SafeId<"caseLawDecision">;
  walkDate: string;
};

/**
 * Snapshot timestamps travel as exact-precision text tokens, never as `Date`:
 * Postgres keeps microseconds, a `Date` keeps milliseconds, and a truncated
 * boundary re-selects the row it was written from forever.
 */
type GenerationBackfillCheckpoint = {
  cursor: GenerationWalkCursor | null;
  generation: string;
  generationOrder: number;
  snapshotAt: TimestampCasToken;
};

const GENERATION_CHECKPOINT_COLUMNS = {
  cursorId: caseLawCorpusIndexBackfills.cursorId,
  cursorWalkDate: caseLawCorpusIndexBackfills.cursorWalkDate,
  generation: caseLawCorpusIndexBackfills.generation,
  generationOrder: caseLawCorpusIndexBackfills.generationOrder,
  snapshotAt: timestampCasToken(caseLawCorpusIndexBackfills.snapshotAt),
  status: caseLawCorpusIndexBackfills.status,
};

type GenerationCheckpointRow = {
  cursorId: SafeId<"caseLawDecision"> | null;
  cursorWalkDate: string | null;
  generation: string;
  generationOrder: number;
  snapshotAt: TimestampCasToken;
};

/**
 * Read a checkpoint row as a checkpoint. The date and the id are stored
 * together or not at all (`case_law_corpus_index_backfills_cursor_pair`), so a
 * half-set cursor is a database invariant violation rather than a state to
 * handle.
 */
const toGenerationCheckpoint = ({
  cursorId,
  cursorWalkDate,
  generation,
  generationOrder,
  snapshotAt,
}: GenerationCheckpointRow): GenerationBackfillCheckpoint => {
  if (cursorWalkDate === null || cursorId === null) {
    if (cursorWalkDate !== null || cursorId !== null) {
      panic("case-law corpus generation cursor is half set");
    }
    return { cursor: null, generation, generationOrder, snapshotAt };
  }
  return {
    cursor: { id: cursorId, walkDate: cursorWalkDate },
    generation,
    generationOrder,
    snapshotAt,
  };
};

/**
 * The walk key of the row a page ended on, as checkpoint columns. An undated
 * row stores the same `-infinity` the walk ordered it by, so the cursor is
 * exactly the position the next page resumes from.
 */
const nextGenerationWalkCursorColumns = (row: {
  decisionDate: string | null;
  id: SafeId<"caseLawDecision">;
}) => ({
  cursorId: row.id,
  cursorWalkDate: row.decisionDate ?? NEGATIVE_INFINITY_DATE,
});

type GenerationBackfillRow = IndexableRow & {
  createdAtToken: TimestampCasToken;
  generationIndexedHash: string | null;
  sourceDescriptor: CorpusSourceDescriptor | null;
};

type SourceReconciliationCheckpoint = {
  cursorCreatedAt: TimestampCasToken | null;
  cursorId: SafeId<"caseLawDecision"> | null;
  generation: string;
  revision: number;
  sourceId: SafeId<"caseLawSource">;
  upperCreatedAt: TimestampCasToken | null;
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
    options: GenerationProjectionGuards & {
      commit: CorpusIndexCommitMode;
      readConcurrency?: number;
      onTiming?: (timing: CorpusBackfillTiming) => void;
    },
  ) => Promise<CorpusBackfillOutcome>;
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

const EMPTY_BACKFILL_OUTCOME = {
  indexed: 0,
  refreshed: 0,
  unread: 0,
} as const satisfies CorpusBackfillOutcome;

/**
 * Commit mode for the pending-queue drain, by the generation's status.
 *
 * A completed generation's drain is the live path: every newly ingested
 * decision waits in that queue, and the mark taken on the way out is the
 * last thing that would ever select it, so acceptance has to mean
 * committed or the row goes permanently missing while Postgres reads
 * indexed. A running generation is still being built: a shortfall there
 * is what its census reports and the repair re-projects, the same
 * backstop that already licenses `auto` on its snapshot pages, while
 * `wait_for` would hold every page for the engine's commit interval.
 */
const PENDING_DRAIN_COMMIT = {
  [CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE]: CORPUS_INDEX_COMMIT.waitFor,
  [CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING]: CORPUS_INDEX_COMMIT.auto,
} as const satisfies Record<
  CaseLawCorpusIndexBackfillStatus,
  CorpusIndexCommitMode
>;

const FIXED_POINT_STAGE = {
  generationBackfillPage: "generation backfill page",
  generationReconciliation: "generation reconciliation",
  sourceEligibilityReconciliation: "source eligibility reconciliation",
} as const;

type FixedPointShortfall = {
  outcome: CorpusBackfillOutcome;
  selected: number;
  stage: (typeof FIXED_POINT_STAGE)[keyof typeof FIXED_POINT_STAGE];
};

/**
 * A page that indexed fewer rows than it selected has not settled, but the
 * count alone does not say why, and the reasons need different answers: a
 * concurrent refresh leaves the row queued for the next cycle, an unreadable
 * corpus object is already recorded as a failed job, and a shortfall neither
 * accounts for is a lost update. Carry the split so the next occurrence is
 * readable from the log rather than only from the analytics sink.
 */
const fixedPointError = ({ outcome, selected, stage }: FixedPointShortfall) =>
  new CorpusIndexError({
    message: `${stage} did not reach a fixed point (selected=${selected} indexed=${outcome.indexed} refreshed=${outcome.refreshed} unread=${outcome.unread})`,
  });

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

export const hasGenerationProjectionTargets = ({
  generation,
  row,
}: {
  generation: string;
  row: GenerationProjectionTargetSources;
}): boolean => generationProjectionTargetIds({ generation, row }).size > 0;

const removeGenerationProjection: GenerationBackfillDependencies["removeProjection"] =
  async (scopedDb, { generation, options, row }) => {
    const targetIndexIds = generationProjectionTargetIds({ generation, row });
    const removals = await settleAll(
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
  and(
    sql`${caseLawCorpusIndexBackfills.cursorWalkDate} IS NOT DISTINCT FROM ${checkpoint.cursor?.walkDate ?? null}::date`,
    sql`${caseLawCorpusIndexBackfills.cursorId} IS NOT DISTINCT FROM ${checkpoint.cursor?.id ?? null}`,
  );

const nextLeaseExpiry = () =>
  sql<Date>`now() + (${BACKFILL_LEASE_MS} * interval '1 millisecond')`;

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
          // The set is fixed by creation time, which no update moves; the
          // cursor orders that set by decision date, which one can. A date
          // correction therefore enqueues the row on the pending queue (see
          // the projection trigger), because a row whose key moved behind the
          // cursor is a row this walk will not reach again.
          sql`${caseLawDecisions.createdAt} <= ${checkpoint.snapshotAt}::timestamptz`,
          checkpoint.cursor === null
            ? undefined
            : sql`(${walkDate}, ${caseLawDecisions.id}) > (${checkpoint.cursor.walkDate}::date, ${checkpoint.cursor.id})`,
        ),
      )
      .orderBy(walkDate, asc(caseLawDecisions.id))
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
            : sql`(${caseLawDecisions.createdAt}, ${caseLawDecisions.id}) <= (${checkpoint.upperCreatedAt}::timestamptz, ${checkpoint.upperId})`,
          checkpoint.cursorCreatedAt === null
            ? undefined
            : sql`(${caseLawDecisions.createdAt}, ${caseLawDecisions.id}) > (${checkpoint.cursorCreatedAt}::timestamptz, ${checkpoint.cursorId})`,
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
          cursorCreatedAt: timestampCasToken(
            caseLawCorpusIndexSourceReconciliations.cursorCreatedAt,
          ),
          cursorId: caseLawCorpusIndexSourceReconciliations.cursorId,
          generation: caseLawCorpusIndexSourceReconciliations.generation,
          revision: caseLawCorpusIndexSourceReconciliations.revision,
          sourceId: caseLawCorpusIndexSourceReconciliations.sourceId,
          upperCreatedAt: timestampCasToken(
            caseLawCorpusIndexSourceReconciliations.upperCreatedAt,
          ),
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

const selectGenerationCheckpointStatus = async (
  scopedDb: Parameters<typeof backfillIncrementalCorpusIndex>[0],
  generation: string,
): Promise<CaseLawCorpusIndexBackfillStatus | null> =>
  await scopedDb(
    async (tx) =>
      (
        await tx
          .select({ status: caseLawCorpusIndexBackfills.status })
          .from(caseLawCorpusIndexBackfills)
          .where(eq(caseLawCorpusIndexBackfills.generation, generation))
          .limit(1)
      ).at(0)?.status ?? null,
  );

const validateGenerationBoundary = (generation: string): void => {
  if (!isCaseLawCorpusGeneration(generation)) {
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
    timestampMatchesCasToken(
      caseLawCorpusIndexSourceReconciliations.cursorCreatedAt,
      checkpoint.cursorCreatedAt,
    ),
    sql`${caseLawCorpusIndexSourceReconciliations.cursorId} IS NOT DISTINCT FROM ${checkpoint.cursorId}`,
    timestampMatchesCasToken(
      caseLawCorpusIndexSourceReconciliations.upperCreatedAt,
      checkpoint.upperCreatedAt,
    ),
    sql`${caseLawCorpusIndexSourceReconciliations.upperId} IS NOT DISTINCT FROM ${checkpoint.upperId}`,
  );

const isCorpusEligible = (row: GenerationBackfillRow): boolean =>
  row.contentHash !== null &&
  isCorpusIndexJurisdiction(row.country) &&
  isRedistributable(row.sourceDescriptor);

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
    // How many corpus objects a page reads at once. The generation walk is
    // bound by object reads, so the caller's setting has to reach the rows
    // here; left unset, the indexer's own default applies.
    options: { readConcurrency?: number } = {},
  ): Promise<CorpusIndexBackfillResult> => {
    validateGenerationBoundary(generation);
    const readConcurrencyOption =
      options.readConcurrency === undefined
        ? {}
        : { readConcurrency: options.readConcurrency };
    // Where the page spends its wall clock. A page is a chain of object
    // reads, engine requests and short transactions, and which one it is
    // waiting on is not visible from the indexed count or from timing the
    // page as a whole. Every batch the page runs reports its own split; the
    // page reports the sum next to its stage times, once, at the end.
    const pageStartedAt = performance.now();
    const sinceMs = (startedAt: number) =>
      Math.round(performance.now() - startedAt);
    const batchTimings: CorpusBackfillTiming[] = [];
    const collectTiming = (timing: CorpusBackfillTiming): void => {
      batchTimings.push(timing);
    };
    const totalOf = (read: (timing: CorpusBackfillTiming) => number): number =>
      batchTimings.reduce((total, timing) => total + read(timing), 0);
    const stageMs = { drain: 0, select: 0, index: 0 };
    // One line per page, on the walking arm: the stage times say which
    // stage the page is in, and the batch totals say what that stage was
    // waiting on. Emitted however the page ends, so a failing page still
    // says where its time went. Counts only, never document content.
    const reportPage = ({
      outcome,
      selected,
      indexed,
      drainedIndexed,
    }: {
      outcome: "advanced" | "busy" | "failed";
      selected: number;
      indexed: number;
      drainedIndexed: number;
    }): void => {
      logger.info("case_law.corpus_index.generation_page", {
        generation,
        batchSize,
        outcome,
        selected,
        indexed,
        drainedIndexed,
        pageMs: sinceMs(pageStartedAt),
        drainMs: stageMs.drain,
        selectMs: stageMs.select,
        indexMs: stageMs.index,
        readMs: totalOf(({ readMs }) => readMs),
        reserveMs: totalOf(({ reserveMs }) => reserveMs),
        removeMs: totalOf(({ removeMs }) => removeMs),
        ingestMs: totalOf(({ ingestMs }) => ingestMs),
        markMs: totalOf(({ markMs }) => markMs),
        engineRequests: totalOf(({ engineRequests }) => engineRequests),
        documents: totalOf(({ documents }) => documents),
      });
    };
    const writerLease = await acquireCaseLawCorpusGenerationLease({
      generation,
      newLeaseToken,
      scopedDb,
    });
    if (!writerLease) {
      return { indexed: 0, status: BACKFILL_STATUS.BUSY };
    }
    try {
      const checkpointRow = await scopedDb(async (tx) => {
        // audit: skip — the checkpoint is the durable audit trail for this derived projection rebuild
        const existing = (
          await tx
            .select(GENERATION_CHECKPOINT_COLUMNS)
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
        // land inside the snapshot this rebuild walks.
        await tx.execute(
          sql`LOCK TABLE ${caseLawDecisions}, ${caseLawSources} IN SHARE MODE`,
        );
        const inserted = await tx
          .insert(caseLawCorpusIndexBackfills)
          .values({ generation, snapshotAt: sql`clock_timestamp()` })
          .onConflictDoNothing()
          .returning(GENERATION_CHECKPOINT_COLUMNS);
        const created = inserted.at(0);
        if (created) {
          return created;
        }

        const concurrent = (
          await tx
            .select(GENERATION_CHECKPOINT_COLUMNS)
            .from(caseLawCorpusIndexBackfills)
            .where(eq(caseLawCorpusIndexBackfills.generation, generation))
            .limit(1)
        ).at(0);
        if (!concurrent) {
          panic("case-law corpus generation checkpoint disappeared");
        }
        return concurrent;
      });
      const checkpoint = toGenerationCheckpoint(checkpointRow);

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
          const outcome =
            eligible.length === 0
              ? EMPTY_BACKFILL_OUTCOME
              : await backfillRows(scopedDb, eligible, generation, {
                  ...guards,
                  ...readConcurrencyOption,
                  onTiming: collectTiming,
                  // A source-wide re-index walks a whole source's corpus
                  // a page at a time, so it is bulk work with the same
                  // census behind it as the snapshot walk.
                  commit: CORPUS_INDEX_COMMIT.auto,
                });
          if (outcome.indexed !== eligible.length) {
            throw fixedPointError({
              outcome,
              selected: eligible.length,
              stage: FIXED_POINT_STAGE.sourceEligibilityReconciliation,
            });
          }
          const { indexed } = outcome;
          const removals = sourcePage.filter(
            (row) =>
              !isCorpusEligible(row) &&
              hasGenerationProjectionTargets({ generation, row }),
          );
          await settleAll(
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
                cursorCreatedAt: sql`${lastSourceRow.createdAtToken}::timestamptz`,
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

        return await reconcilePendingPage({ guards, status });
      };

      // The pending queue is the live path: every newly ingested decision
      // waits here, so it must be drainable on its own, without the
      // source-first composition reconcilePending applies after a completed
      // walk. A queued source repair can span the whole corpus of a source;
      // routing the live drain behind it would recreate the wedge this
      // ordering exists to prevent.
      const reconcilePendingPage = async ({
        guards,
        status,
      }: {
        guards: ReturnType<typeof createLeaseGuards>;
        status: CaseLawCorpusIndexBackfillStatus;
      }): Promise<CorpusIndexBackfillResult> => {
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
              !hasGenerationProjectionTargets({ generation, row }),
          )
          .map(withoutSourceDescriptor);
        const terminalDeletes = pendingIndexRows.filter(
          (row) =>
            !isCorpusEligible(row) &&
            hasGenerationProjectionTargets({ generation, row }),
        );
        const outcome =
          eligible.length === 0
            ? EMPTY_BACKFILL_OUTCOME
            : await backfillRows(scopedDb, eligible, generation, {
                ...guards,
                ...readConcurrencyOption,
                onTiming: collectTiming,
                commit: PENDING_DRAIN_COMMIT[status],
              });
        if (outcome.indexed !== eligible.length) {
          throw fixedPointError({
            outcome,
            selected: eligible.length,
            stage: FIXED_POINT_STAGE.generationReconciliation,
          });
        }
        const { indexed } = outcome;
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
        const removePendingProjection = async (
          rows: readonly GenerationBackfillRow[],
          index = 0,
        ): Promise<void> => {
          const row = rows.at(index);
          if (!row) {
            return;
          }
          await removeProjection(scopedDb, {
            generation,
            options: guards,
            row,
          });
          await removePendingProjection(rows, index + 1);
        };
        await removePendingProjection([
          ...pendingDeleteRows,
          ...terminalDeletes,
        ]);
        return { indexed, status: BACKFILL_STATUS.ADVANCED };
      };

      // Pending projections only: the running-arm drain. Source-eligibility
      // revisions stay gated on a completed walk (their replay is
      // authoritative over anything indexed here, so draining pending rows
      // first cannot break that convergence).
      const drainPendingProjections = async ({
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
        return await reconcilePendingPage({ guards, status });
      };

      if (
        checkpointRow.status === CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE
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
            .returning(GENERATION_CHECKPOINT_COLUMNS);
          return claimedRows.at(0);
        });
        if (!claimedReconciliation) {
          return { indexed: 0, status: BACKFILL_STATUS.BUSY };
        }
        const reconciliationCheckpoint = toGenerationCheckpoint(
          claimedReconciliation,
        );
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
              or(
                isNull(caseLawCorpusIndexBackfills.leaseExpiresAt),
                lte(caseLawCorpusIndexBackfills.leaseExpiresAt, sql`now()`),
              ),
            ),
          )
          .returning(GENERATION_CHECKPOINT_COLUMNS);
        return rows.at(0);
      });
      if (!claimed) {
        return { indexed: 0, status: BACKFILL_STATUS.BUSY };
      }

      const claimedCheckpoint = toGenerationCheckpoint(claimed);
      const runningGuards = createLeaseGuards({
        checkpoint: claimedCheckpoint,
        leaseToken,
        status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
      });
      type ClaimedLeaseState =
        | { type: "held"; status: CaseLawCorpusIndexBackfillStatus }
        | { type: "released" };
      type ClaimedLease = { state: ClaimedLeaseState };
      type CompletionState =
        | { type: "pending" }
        | { type: "reconciled"; result: CorpusIndexBackfillResult };
      type Completion = { state: CompletionState };
      const claimedLease: ClaimedLease = {
        state: {
          type: "held",
          status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
        },
      };
      const completion: Completion = { state: { type: "pending" } };
      const operation = await Result.tryPromise(async () => {
        await runningGuards.beforeRemoteEffect({
          effect: completeRemoteEffect,
          onLeaseLost: async () => await Promise.resolve(),
        });

        // Drain the pending queue before walking the snapshot. Pending
        // projections are live decision traffic; the walk is a bounded rebuild
        // of pre-snapshot rows, and a generation can sit at `running` for a long
        // time (or forever, when its walk is wedged). Draining under RUNNING
        // keeps newly ingested decisions searchable regardless of walk state,
        // and draining first means a row that wedges the walk cannot also wedge
        // live indexing. The pending_revision epoch converges these appends with
        // walk pages that later reach the same rows.
        let drainedIndexed = 0;
        try {
          const drainStartedAt = performance.now();
          let drained: CorpusIndexBackfillResult;
          try {
            drained = await drainPendingProjections({
              checkpoint: claimedCheckpoint,
              leaseToken,
              status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.RUNNING,
            });
          } finally {
            stageMs.drain = sinceMs(drainStartedAt);
          }
          if (drained.status === BACKFILL_STATUS.BUSY) {
            reportPage({
              outcome: "busy",
              selected: 0,
              indexed: 0,
              drainedIndexed: 0,
            });
            return drained;
          }
          drainedIndexed = drained.indexed;
        } catch (error) {
          reportPage({
            outcome: "failed",
            selected: 0,
            indexed: 0,
            drainedIndexed: 0,
          });
          throw error;
        }
        // Reports this invocation's total durable movement: rows the drain
        // indexed count as ADVANCED even when the walk itself could not.
        const withDrained = (
          result: CorpusIndexBackfillResult,
        ): CorpusIndexBackfillResult => {
          if (drainedIndexed === 0) {
            return result;
          }
          return result.status === BACKFILL_STATUS.ADVANCED
            ? {
                indexed: result.indexed + drainedIndexed,
                status: BACKFILL_STATUS.ADVANCED,
              }
            : { indexed: drainedIndexed, status: BACKFILL_STATUS.ADVANCED };
        };

        const selectStartedAt = performance.now();
        const page = await selectGenerationBackfillPage(scopedDb, {
          batchSize,
          checkpoint: claimedCheckpoint,
        });
        stageMs.select = sinceMs(selectStartedAt);
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
              .returning(GENERATION_CHECKPOINT_COLUMNS);
            return rows.at(0);
          });
          if (!completed) {
            return withDrained({ indexed: 0, status: BACKFILL_STATUS.BUSY });
          }
          claimedLease.state = {
            type: "held",
            status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
          };
          const completedCheckpoint = toGenerationCheckpoint(completed);
          try {
            completion.state = {
              result: withDrained(
                await reconcilePending({
                  checkpoint: completedCheckpoint,
                  leaseToken,
                  status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
                }),
              ),
              type: "reconciled",
            };
            return completion.state.result;
          } finally {
            await releaseLease({
              leaseToken,
              status: CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE,
            });
            claimedLease.state = { type: "released" };
          }
        }

        const rows = page
          .filter((row) => isEligibleForGeneration(row, generation))
          .map(withoutSourceDescriptor);
        const removals = page.filter(
          (row) =>
            !isCorpusEligible(row) &&
            hasGenerationProjectionTargets({ generation, row }),
        );
        let indexed: number;
        const indexStartedAt = performance.now();
        try {
          // The drain above may have brought every row on this page current, so
          // skip the indexer rather than hand it an empty batch.
          const outcome =
            rows.length === 0
              ? EMPTY_BACKFILL_OUTCOME
              : await backfillRows(scopedDb, rows, generation, {
                  ...runningGuards,
                  ...readConcurrencyOption,
                  onTiming: collectTiming,
                  // Snapshot pages of the rebuild: bulk throughput, whose
                  // completeness the generation's census verifies rather
                  // than each request proving it for itself.
                  commit: CORPUS_INDEX_COMMIT.auto,
                });
          if (outcome.indexed !== rows.length) {
            throw fixedPointError({
              outcome,
              selected: rows.length,
              stage: FIXED_POINT_STAGE.generationBackfillPage,
            });
          }
          indexed = outcome.indexed;
          await settleAll(
            removals.map(async (row) => {
              await removeProjection(scopedDb, {
                generation,
                options: runningGuards,
                row,
              });
            }),
          );
        } catch (error) {
          // Keep the cursor intact, but do not make a transient search/S3 failure
          // wait for a stale lease before its durable retry.
          reportPage({
            outcome: "failed",
            selected: rows.length,
            indexed: 0,
            drainedIndexed,
          });
          throw error;
        } finally {
          stageMs.index = sinceMs(indexStartedAt);
        }

        const advanced = await scopedDb(async (tx) => {
          // audit: skip — cursor advancement is the durable audit trail for this derived rebuild
          const advancedRows = await tx
            .update(caseLawCorpusIndexBackfills)
            .set({
              ...nextGenerationWalkCursorColumns(last),
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
        if (advanced) {
          claimedLease.state = { type: "released" };
        }
        reportPage({
          outcome: advanced ? "advanced" : "busy",
          selected: rows.length,
          indexed,
          drainedIndexed,
        });
        return withDrained(
          advanced
            ? { indexed, status: BACKFILL_STATUS.ADVANCED }
            : { indexed: 0, status: BACKFILL_STATUS.BUSY },
        );
      });
      const claimedLeaseState = claimedLease.state;
      const completionState = completion.state;
      const released =
        claimedLeaseState.type === "released"
          ? null
          : await Result.tryPromise(
              async () =>
                await releaseLease({
                  leaseToken,
                  status: claimedLeaseState.status,
                }),
            );
      if (Result.isError(operation)) {
        if (released !== null && Result.isError(released)) {
          logger.error(
            "case_law.corpus_index.generation_lease_release_failed",
            errorSystemFields(released.error.cause),
          );
        }
        if (
          completionState.type === "reconciled" &&
          released !== null &&
          !Result.isError(released)
        ) {
          return completionState.result;
        }
        throw operation.error.cause;
      }
      if (released !== null && Result.isError(released)) {
        throw released.error.cause;
      }
      return operation.value;
    } finally {
      await writerLease.release();
    }
  };

/**
 * Advance one durable generation-rebuild page. The page is bounded by the
 * `(decision_date,id)` cursor before any generation comparison is made, so a
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
  const [sourceReconciliation, pendingProjection, checkpointStatus] =
    await Promise.all([
      selectSourceReconciliationCheckpoint(scopedDb, generation),
      hasPendingGenerationProjection(scopedDb, generation),
      selectGenerationCheckpointStatus(scopedDb, generation),
    ]);
  // A serving generation without a checkpoint has no durable projection
  // targets yet (inventing a synthetic completed checkpoint would suppress
  // that replay and leave future appends without a crash-recoverable target
  // record), and one still `running` owes the rest of its snapshot walk.
  // Both need the generation page. The second condition is load-bearing on
  // its own: the pending drain empties the queue on the very invocations
  // that advance the walk, so a quiet corpus with nothing pending must not
  // park an incomplete walk on the incremental path.
  if (
    checkpointStatus !== CASE_LAW_CORPUS_INDEX_BACKFILL_STATUS.COMPLETE ||
    sourceReconciliation ||
    pendingProjection
  ) {
    const result = await backfillCorpusIndexGenerationPage(
      scopedDb,
      batchSize,
      generation,
      options,
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
