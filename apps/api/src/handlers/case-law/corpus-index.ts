import { and, eq, isNull, or, sql } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
} from "@/api/db/schema";
import {
  readCorpusAst,
  readCorpusText,
} from "@/api/handlers/case-law/corpus-storage";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusChunk } from "@/api/lib/corpus-index/chunking";
import {
  chunkDocument,
  formatHeadingPath,
} from "@/api/lib/corpus-index/chunking";
import type { CorpusDocumentPayload } from "@/api/lib/corpus-index/core";
import { createCorpusIndexer } from "@/api/lib/corpus-index/core";

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
  updatedAt: Date;
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
  updatedAt: caseLawDecisions.updatedAt,
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

const indexer = createCorpusIndexer<"caseLawDecision", IndexableRow>({
  family: "case_law",
  captureStep: "backfillCorpusIndex.loadText",
  granularity: "passage",
  buildDocs,
  readCorpusText,
  readCorpusAst,
  // The scans deliberately carry no ORDER BY. Any pick order makes
  // progress (indexed rows leave the pending set), while ordering by
  // created_at steers the planner onto the created_at index and
  // row-by-row heap filtering; the selective content-hash index is what
  // these scans need.
  selectMissing: async (scopedDb, { generation, limit }) =>
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
            or(
              isNull(caseLawDecisions.indexedGeneration),
              sql`${caseLawDecisions.indexedGeneration} <> (${generation} || '_' || lower(${caseLawDecisions.country}))`,
            ),
          ),
        )
        .limit(limit),
    ),
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
  markIndexed: async (tx, { row, indexId, now }) => {
    // audit: skip — search index maintenance; rebuilds derived state
    const marked = await tx
      .update(caseLawDecisions)
      .set({
        indexedHash: row.contentHash,
        indexedGeneration: indexId,
        indexedAt: now,
      })
      .where(
        and(
          eq(caseLawDecisions.id, row.id),
          sql`${caseLawDecisions.indexedHash} IS NOT DISTINCT FROM ${row.indexedHash}`,
          sql`${caseLawDecisions.updatedAt} IS NOT DISTINCT FROM ${row.updatedAt}`,
        ),
      )
      .returning({ id: caseLawDecisions.id });
    return marked.length > 0;
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
});

export const loadDocsForBatch = indexer.loadDocsForBatch;
export const backfillCorpusIndex = indexer.backfill;
export const removeDecisionFromCorpusIndex = indexer.remove;
