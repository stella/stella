import { Result } from "better-result";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import {
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
} from "@/api/db/schema";
import { readCorpusText } from "@/api/handlers/case-law/corpus-storage";
import { redistributableCaseLawSource } from "@/api/handlers/case-law/redistribution";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getCorpusIndexClient,
  type CorpusIndexError,
} from "@/api/lib/legal-search/corpus-index-client";
import { caseLawIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";

/**
 * corpus index search-projection maintenance. Mirrors search-index.ts (the
 * pg-fts projection): a backfill loop indexes corpus-backed decisions
 * whose content changed or that are missing from the active generation.
 * The license gate lives in the SQL filter so non-redistributable
 * sources never enter the scan (and cannot stall it). Every mutation is
 * recorded in the case_law_index_jobs audit trail.
 */

const INDEX_CONCURRENCY = 4;

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
  fulltext: string | null;
  contentHash: string | null;
  indexedHash: string | null;
  indexedGeneration: string | null;
  updatedAt: Date;
};

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
  fulltext: caseLawDecisions.fulltext,
  contentHash: caseLawDecisions.contentHash,
  indexedHash: caseLawDecisions.indexedHash,
  indexedGeneration: caseLawDecisions.indexedGeneration,
  updatedAt: caseLawDecisions.updatedAt,
};

// A row is indexable once its canonical payload is in object storage.
const hasContent = sql`${caseLawDecisions.contentHash} IS NOT NULL`;

// Per-jurisdiction indexes are created on first write. Cache the ids we
// have confirmed this process so we don't probe corpus index every batch.
const ensuredIndexes = new Set<string>();

const ensureIndex = async (
  indexId: string,
): Promise<Result<void, CorpusIndexError>> => {
  if (ensuredIndexes.has(indexId)) {
    return Result.ok(undefined);
  }
  const client = getCorpusIndexClient();
  const exists = await client.indexExists(indexId);
  if (exists.isErr()) {
    return Result.err(exists.error);
  }
  if (!exists.value) {
    const created = await client.createIndex(caseLawIndexConfig(indexId));
    if (created.isErr()) {
      return Result.err(created.error);
    }
  }
  ensuredIndexes.add(indexId);
  return Result.ok(undefined);
};

/** Build the corpus index search document, omitting empty optional fields. */
const buildDoc = (row: IndexableRow, text: string): Record<string, unknown> => {
  // eslint-disable-next-line no-untyped-updates/no-untyped-updates -- corpus index ingest document, not a DB update
  const doc: Record<string, unknown> = {
    document_id: row.id,
    jurisdiction: row.country,
    source: row.sourceId,
    court: row.court,
    language: row.language,
    title: `${row.caseNumber} — ${row.court}`,
    text,
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

const loadText = async (row: IndexableRow): Promise<string> => {
  // No catch-and-fallback: a transient S3 failure must abort the batch so
  // the daemon retries. Swallowing it would index empty text and then
  // record indexedHash = contentHash, permanently pinning a broken entry.
  if (row.textS3Key !== null) {
    return await readCorpusText(row.textS3Key);
  }
  return row.fulltext ?? "";
};

/**
 * Index a batch of corpus-backed decisions into the given generation.
 * Two-query missing/stale split mirrors backfillSearchIndex: `missing`
 * = not yet in this generation; `stale` = content changed since last
 * push. Reserves a quarter of the batch for stale so re-indexes are not
 * starved by a missing-doc backlog. Returns the number indexed.
 */
export const backfillCorpusIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
  generation: string,
): Promise<number> => {
  const staleReserved = Math.max(1, Math.floor(batchSize / 4));
  const missingLimit = Math.max(1, batchSize - staleReserved);

  const missing = await scopedDb((tx) =>
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
      .orderBy(asc(caseLawDecisions.createdAt))
      .limit(missingLimit),
  );

  const staleLimit = batchSize - missing.length;
  const stale =
    staleLimit <= 0
      ? []
      : await scopedDb((tx) =>
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
            .orderBy(asc(caseLawDecisions.createdAt))
            .limit(staleLimit),
        );

  const rows: IndexableRow[] = [...missing, ...stale];
  if (rows.length === 0) {
    return 0;
  }

  // Load text (S3) with bounded concurrency, then ingest one NDJSON batch.
  const docs: { row: IndexableRow; doc: Record<string, unknown> }[] = [];
  for (let i = 0; i < rows.length; i += INDEX_CONCURRENCY) {
    const chunk = rows.slice(i, i + INDEX_CONCURRENCY);
    const built = await Promise.all(
      chunk.map(async (row) => ({
        row,
        doc: buildDoc(row, await loadText(row)),
      })),
    );
    docs.push(...built);
  }

  // Route each doc to its jurisdiction's index (case_law_v1_<country>),
  // grouping so each index gets one NDJSON ingest. A group that fails to
  // ensure/ingest is recorded and retried next cycle; other groups still
  // commit.
  const groups = new Map<string, typeof docs>();
  for (const entry of docs) {
    const indexId = corpusIndexId(generation, entry.row.country);
    const group = groups.get(indexId);
    if (group) {
      group.push(entry);
    } else {
      groups.set(indexId, [entry]);
    }
  }

  const now = new Date();
  let indexed = 0;
  let firstError: CorpusIndexError | null = null;

  for (const [indexId, group] of groups) {
    // Ingest appends; it never replaces. Before re-ingesting, delete the
    // previously indexed copy from wherever it lives (the same index for
    // a content refresh, another jurisdiction index for a corrected
    // country), or stale copies keep matching old text. Same generation
    // only: generation rebuilds replace whole indexes. Engine delete
    // tasks only affect splits that already exist, so the copy ingested
    // below is not at risk.
    const moved = group.flatMap(({ row }) =>
      row.indexedGeneration !== null &&
      row.indexedGeneration.startsWith(`${generation}_`)
        ? [{ id: row.id, oldIndexId: row.indexedGeneration }]
        : [],
    );
    let staleError: CorpusIndexError | null = null;
    for (const entry of moved) {
      const removed = await getCorpusIndexClient().deleteByQuery(
        entry.oldIndexId,
        `document_id:"${entry.id}"`,
      );
      await recordJobs(
        scopedDb,
        [
          {
            decisionId: entry.id,
            contentHash: null,
            operation: "delete" as const,
            status: removed.isErr()
              ? ("failed" as const)
              : ("succeeded" as const),
            ...(removed.isErr()
              ? { errorMessage: removed.error.message.slice(0, 2048) }
              : {}),
          },
        ],
        entry.oldIndexId,
      );
      if (removed.isErr()) {
        staleError = removed.error;
        break;
      }
    }
    if (staleError) {
      firstError ??= staleError;
      continue;
    }

    const ensured = await ensureIndex(indexId);
    const ingest = ensured.isErr()
      ? ensured
      : await getCorpusIndexClient().ingestBatch(
          indexId,
          group.map(({ doc }) => JSON.stringify(doc)).join("\n"),
        );

    if (ingest.isErr()) {
      firstError ??= ingest.error;
      await recordJobs(
        scopedDb,
        group.map(({ row }) => ({
          decisionId: row.id,
          contentHash: row.contentHash,
          operation: "index" as const,
          status: "failed" as const,
          errorMessage: ingest.error.message.slice(0, 2048),
        })),
        indexId,
      );
      continue;
    }

    await scopedDb(async (tx) => {
      // audit: skip — search index maintenance; rebuilds derived state
      for (const { row } of group) {
        // Compare-and-set on the selected row state: a concurrent
        // re-ingest clears indexedHash (possibly leaving it null-to-null
        // when the row was already pending) and bumps updatedAt, and an
        // unconditional write would mask that refresh so the stale index
        // document would never be retried.
        await tx
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
          );
      }
      await tx.insert(caseLawIndexJobs).values(
        group.map(({ row }) => ({
          decisionId: row.id,
          generation: indexId,
          operation: "index" as const,
          status: "succeeded" as const,
          contentHash: row.contentHash,
        })),
      );
    });
    indexed += group.length;
  }

  // Surface a failure so the daemon retries the un-indexed groups.
  if (firstError) {
    // eslint-disable-next-line no-throw-literal -- CorpusIndexError (TaggedError); rethrow to abort the batch for retry
    throw firstError;
  }

  return indexed;
};

type JobInput = {
  decisionId: SafeId<"caseLawDecision">;
  contentHash: string | null;
  operation: "index" | "delete" | "redact" | "rebuild";
  status: "succeeded" | "failed";
  errorMessage?: string;
};

const recordJobs = async (
  scopedDb: ScopedDb,
  jobs: readonly JobInput[],
  generation: string,
): Promise<void> => {
  if (jobs.length === 0) {
    return;
  }
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
  await scopedDb((tx) => {
    // audit: skip — append-only index-job rows ARE the indexing audit trail
    return tx.insert(caseLawIndexJobs).values(
      jobs.map((job) => ({
        decisionId: job.decisionId,
        generation,
        operation: job.operation,
        status: job.status,
        contentHash: job.contentHash,
        errorMessage: job.errorMessage ?? null,
      })),
    );
  });
};

/**
 * Remove a decision from a corpus index generation (GDPR/takedown). Uses a
 * delete-task (corpus index's async delete path) and records the operation.
 */
export const removeDecisionFromCorpusIndex = async (
  decisionId: SafeId<"caseLawDecision">,
  scopedDb: ScopedDb,
  indexId: string,
  operation: "delete" | "redact" = "delete",
): Promise<Result<void, CorpusIndexError>> => {
  const result = await getCorpusIndexClient().deleteByQuery(
    indexId,
    `document_id:"${decisionId}"`,
  );
  await recordJobs(
    scopedDb,
    [
      {
        decisionId,
        contentHash: null,
        operation,
        status: result.isErr() ? "failed" : "succeeded",
        ...(result.isErr()
          ? { errorMessage: result.error.message.slice(0, 2048) }
          : {}),
      },
    ],
    indexId,
  );
  return result;
};
