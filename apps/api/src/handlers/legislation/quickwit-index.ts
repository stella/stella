import { Result } from "better-result";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import {
  legislationDocuments,
  legislationIndexJobs,
  legislationSources,
} from "@/api/db/schema";
import { readCorpusText } from "@/api/handlers/case-law/corpus-storage";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import {
  getQuickwitClient,
  type QuickwitError,
} from "@/api/lib/legal-search/quickwit-client";
import { corpusIndexConfig } from "@/api/lib/legal-search/quickwit-index-config";

/**
 * Quickwit projection for the `legislation` family. Mirrors
 * case-law/quickwit-index.ts: per-jurisdiction indexes
 * (`legislation_v1_<country>`), license gate in SQL, batch ingest with a
 * per-group commit, audit trail in legislation_index_jobs.
 */

const INDEX_CONCURRENCY = 4;

type IndexableRow = {
  id: SafeId<"legislationDocument">;
  sourceId: SafeId<"legislationSource">;
  eli: string;
  title: string;
  country: string;
  language: string;
  documentType: string | null;
  status: string;
  effectiveDate: string | null;
  versionValidFrom: string | null;
  citationAuthority: number;
  citationCount: number;
  textS3Key: string | null;
  astS3Key: string | null;
  fulltext: string | null;
  contentHash: string | null;
};

const SELECT_COLUMNS = {
  id: legislationDocuments.id,
  sourceId: legislationDocuments.sourceId,
  eli: legislationDocuments.eli,
  title: legislationDocuments.title,
  country: legislationDocuments.country,
  language: legislationDocuments.language,
  documentType: legislationDocuments.documentType,
  status: legislationDocuments.status,
  effectiveDate: legislationDocuments.effectiveDate,
  versionValidFrom: legislationDocuments.versionValidFrom,
  citationAuthority: legislationDocuments.citationAuthority,
  citationCount: legislationDocuments.citationCount,
  textS3Key: legislationDocuments.textS3Key,
  astS3Key: legislationDocuments.astS3Key,
  fulltext: legislationDocuments.fulltext,
  contentHash: legislationDocuments.contentHash,
};

const redistributable = sql`(
  ${legislationSources.descriptor} IS NULL
  OR (${legislationSources.descriptor} ->> 'allowsRedistribution') = 'true'
)`;

const hasContent = sql`${legislationDocuments.contentHash} IS NOT NULL`;

const ensuredIndexes = new Set<string>();

const ensureIndex = async (
  indexId: string,
): Promise<Result<void, QuickwitError>> => {
  if (ensuredIndexes.has(indexId)) {
    return Result.ok(undefined);
  }
  const client = getQuickwitClient();
  const exists = await client.indexExists(indexId);
  if (exists.isErr()) {
    return Result.err(exists.error);
  }
  if (!exists.value) {
    const created = await client.createIndex(
      corpusIndexConfig("legislation", indexId),
    );
    if (created.isErr()) {
      return Result.err(created.error);
    }
  }
  ensuredIndexes.add(indexId);
  return Result.ok(undefined);
};

const buildDoc = (row: IndexableRow, text: string): Record<string, unknown> => {
  const doc: Record<string, unknown> = {
    document_id: row.id,
    jurisdiction: row.country,
    source: row.sourceId,
    language: row.language,
    title: row.title,
    text,
    status: row.status,
    eli: row.eli,
    citation_authority: row.citationAuthority,
    citation_count: row.citationCount,
  };
  if (row.documentType !== null) {
    doc["document_type"] = row.documentType;
  }
  const dateForYear = row.effectiveDate ?? row.versionValidFrom;
  if (row.effectiveDate !== null) {
    doc["effective_date"] = row.effectiveDate;
  }
  if (dateForYear !== null) {
    doc["year"] = Number(dateForYear.slice(0, 4));
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
  if (row.textS3Key !== null) {
    try {
      return await readCorpusText(row.textS3Key);
    } catch (error) {
      captureError(error, {
        documentId: row.id,
        step: "legislationQuickwitIndex.loadText",
      });
    }
  }
  return row.fulltext ?? "";
};

export const backfillLegislationQuickwitIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
  generation: string,
): Promise<number> => {
  const staleReserved = Math.max(1, Math.floor(batchSize / 4));
  const missingLimit = Math.max(1, batchSize - staleReserved);

  const missing = await scopedDb((tx) =>
    tx
      .select(SELECT_COLUMNS)
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          hasContent,
          redistributable,
          or(
            isNull(legislationDocuments.indexedGeneration),
            sql`${legislationDocuments.indexedGeneration} <> (${generation} || '_' || lower(${legislationDocuments.country}))`,
          ),
        ),
      )
      .orderBy(asc(legislationDocuments.createdAt))
      .limit(missingLimit),
  );

  const staleLimit = batchSize - missing.length;
  const stale =
    staleLimit <= 0
      ? []
      : await scopedDb((tx) =>
          tx
            .select(SELECT_COLUMNS)
            .from(legislationDocuments)
            .innerJoin(
              legislationSources,
              eq(legislationSources.id, legislationDocuments.sourceId),
            )
            .where(
              and(
                hasContent,
                redistributable,
                sql`${legislationDocuments.indexedGeneration} = (${generation} || '_' || lower(${legislationDocuments.country}))`,
                sql`${legislationDocuments.indexedHash} IS DISTINCT FROM ${legislationDocuments.contentHash}`,
              ),
            )
            .orderBy(asc(legislationDocuments.createdAt))
            .limit(staleLimit),
        );

  const rows: IndexableRow[] = [...missing, ...stale];
  if (rows.length === 0) {
    return 0;
  }

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
  let firstError: QuickwitError | null = null;

  for (const [indexId, group] of groups) {
    const ensured = await ensureIndex(indexId);
    const ingest = ensured.isErr()
      ? ensured
      : await getQuickwitClient().ingestBatch(
          indexId,
          group.map(({ doc }) => JSON.stringify(doc)).join("\n"),
        );

    if (ingest.isErr()) {
      firstError ??= ingest.error;
      await recordJobs(
        scopedDb,
        group.map(({ row }) => ({
          documentId: row.id,
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
        await tx
          .update(legislationDocuments)
          .set({
            indexedHash: row.contentHash,
            indexedGeneration: indexId,
            indexedAt: now,
          })
          .where(eq(legislationDocuments.id, row.id));
      }
      await tx.insert(legislationIndexJobs).values(
        group.map(({ row }) => ({
          documentId: row.id,
          generation: indexId,
          operation: "index" as const,
          status: "succeeded" as const,
          contentHash: row.contentHash,
        })),
      );
    });
    indexed += group.length;
  }

  if (firstError) {
    throw firstError;
  }

  return indexed;
};

type JobInput = {
  documentId: SafeId<"legislationDocument">;
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
  await scopedDb((tx) => {
    // audit: skip — search index maintenance; rebuilds derived state
    return tx.insert(legislationIndexJobs).values(
      jobs.map((job) => ({
        documentId: job.documentId,
        generation,
        operation: job.operation,
        status: job.status,
        contentHash: job.contentHash,
        errorMessage: job.errorMessage ?? null,
      })),
    );
  });
};

export const removeLegislationFromQuickwit = async (
  documentId: SafeId<"legislationDocument">,
  scopedDb: ScopedDb,
  indexId: string,
  operation: "delete" | "redact" = "delete",
): Promise<void> => {
  const result = await getQuickwitClient().deleteByQuery(
    indexId,
    `document_id:"${documentId}"`,
  );
  await recordJobs(
    scopedDb,
    [
      {
        documentId,
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
  if (result.isErr()) {
    throw result.error;
  }
};
