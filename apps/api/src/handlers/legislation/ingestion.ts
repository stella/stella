import { and, eq, sql } from "drizzle-orm";

import type { DocumentAst } from "@stll/case-law/document-ast";

import type { ScopedDb } from "@/api/db";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import {
  corpusContentHash,
  writeCorpusDocument,
} from "@/api/handlers/case-law/corpus-storage";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import {
  sanitizeMetadata,
  stripDangerousChars,
} from "@/api/handlers/case-law/ingestion/sanitize";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Legislation ingestion. The canonical, source-agnostic entry is
 * `processLegislationDocument` (store + upsert), which any source feeds —
 * a structured import today, or a `LegislationAdapter` (Slov-Lex /
 * eSbírka / Polish Sejm) once its source-specific fetch+parse is built.
 * The substrate (object storage, Quickwit index, pg-fts projection,
 * search, erasure) is shared with case law via the `legislation` family.
 */

export type LegislationStatus = "current" | "historical" | "repealed" | "draft";

/** Normalized legislation document — what every source produces. */
export type LegislationDocumentInput = {
  sourceId: SafeId<"legislationSource">;
  /** Work identifier (ELI / national statute id), shared across versions. */
  eli: string;
  title: string;
  country: string;
  language: string;
  documentType?: string | null;
  status?: LegislationStatus;
  effectiveDate?: string | null;
  /** Point-in-time consolidation window; null versionValidTo = current. */
  versionValidFrom?: string | null;
  versionValidTo?: string | null;
  fulltext?: string | null;
  sections?: DecisionSection[] | null;
  ast?: DocumentAst | EmptyAst | null;
  sourceUrl?: string | null;
  documentUrl?: string | null;
  metadata?: Record<string, unknown>;
};

export type ProcessLegislationResult = {
  id: SafeId<"legislationDocument">;
  inserted: boolean;
  skipped: boolean;
};

/**
 * A legislation source. Implement one per provider (Slov-Lex, eSbírka,
 * Polish Sejm ELI API). `fetchPage` returns normalized documents + the
 * next cursor; the runner persists them via processLegislationDocument.
 */
export type LegislationAdapter = {
  adapterKey: string;
  fetchPage: (
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<{
    documents: LegislationDocumentInput[];
    nextCursor: string | null;
  }>;
};

const sanitizeInput = (
  input: LegislationDocumentInput,
): LegislationDocumentInput => ({
  ...input,
  eli: stripDangerousChars(input.eli),
  title: stripDangerousChars(input.title),
  fulltext: input.fulltext != null ? stripDangerousChars(input.fulltext) : null,
  metadata: sanitizeMetadata(input.metadata ?? {}),
});

/**
 * Store + upsert one legislation document. Deduplicates by content hash:
 * an unchanged re-ingest is skipped. When CORPUS_STORAGE_ENABLED, the
 * canonical payload is written to object storage (outside the tx) and
 * the row's S3 keys + content hash are recorded so the indexers pick it
 * up. The pg-fts and Quickwit projections are maintained by the backfill
 * loops (not inline), matching the case-law pipeline.
 */
export const processLegislationDocument = async (
  raw: LegislationDocumentInput,
  scopedDb: ScopedDb,
): Promise<ProcessLegislationResult> => {
  const input = sanitizeInput(raw);
  const text = input.fulltext ?? null;
  const sections = input.sections ?? null;
  const ast = input.ast ?? null;
  const sourceHash = corpusContentHash({ text, sections, ast });

  const versionMatch = sql`${legislationDocuments.versionValidFrom} IS NOT DISTINCT FROM ${input.versionValidFrom ?? null}`;

  const [existing] = await scopedDb((tx) =>
    tx
      .select({
        id: legislationDocuments.id,
        sourceHash: legislationDocuments.sourceHash,
      })
      .from(legislationDocuments)
      .where(
        and(
          eq(legislationDocuments.sourceId, input.sourceId),
          eq(legislationDocuments.eli, input.eli),
          eq(legislationDocuments.language, input.language),
          versionMatch,
        ),
      )
      .limit(1),
  );

  if (existing && existing.sourceHash === sourceHash) {
    return { id: existing.id, inserted: false, skipped: true };
  }

  const values = {
    sourceId: input.sourceId,
    eli: input.eli,
    title: input.title,
    country: input.country,
    language: input.language,
    documentType: input.documentType ?? null,
    status: input.status ?? "current",
    effectiveDate: input.effectiveDate ?? null,
    versionValidFrom: input.versionValidFrom ?? null,
    versionValidTo: input.versionValidTo ?? null,
    fulltext: text,
    sections,
    documentAst: ast,
    sourceUrl: input.sourceUrl ?? null,
    documentUrl: input.documentUrl ?? null,
    metadata: input.metadata ?? {},
    sourceHash,
  };

  const id = await scopedDb(async (tx) => {
    // audit: skip — background legislation ingestion; public data, not user actions
    if (existing) {
      await tx
        .update(legislationDocuments)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(legislationDocuments.id, existing.id));
      return existing.id;
    }
    const [row] = await tx
      .insert(legislationDocuments)
      .values(values)
      .returning({ id: legislationDocuments.id });
    if (!row) {
      throw new Error("Failed to insert legislation document");
    }
    return row.id;
  });

  if (envBase.CORPUS_STORAGE_ENABLED) {
    try {
      const written = await writeCorpusDocument({
        documentId: id,
        jurisdiction: input.country,
        text,
        sections,
        ast,
      });
      // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive
      await scopedDb((tx) => {
        // audit: skip — background corpus storage; derived state
        return tx
          .update(legislationDocuments)
          .set({
            textS3Key: written.textKey,
            normalizedS3Key: written.sectionsKey,
            astS3Key: written.astKey,
            contentHash: written.contentHash,
          })
          .where(eq(legislationDocuments.id, id));
      });
    } catch (error) {
      captureError(error, {
        documentId: id,
        step: "processLegislationDocument.corpusWrite",
      });
    }
  }

  return { id, inserted: !existing, skipped: false };
};

/**
 * Drive a legislation adapter: fetch pages, persist each document, and
 * advance the source cursor. Bounded by maxPages per cycle.
 */
export const runLegislationIngestion = async ({
  adapter,
  source,
  scopedDb,
  signal,
  maxPages,
}: {
  adapter: LegislationAdapter;
  source: { id: SafeId<"legislationSource">; syncCursor: string | null };
  scopedDb: ScopedDb;
  signal: AbortSignal;
  maxPages: number;
}): Promise<{
  inserted: number;
  skipped: number;
  nextCursor: string | null;
}> => {
  let cursor = source.syncCursor;
  let inserted = 0;
  let skipped = 0;

  for (let page = 0; page < maxPages; page += 1) {
    if (signal.aborted) {
      break;
    }
    const { documents, nextCursor } = await adapter.fetchPage(cursor, signal);
    for (const doc of documents) {
      const result = await processLegislationDocument(doc, scopedDb);
      if (result.skipped) {
        skipped += 1;
      } else {
        inserted += 1;
      }
    }
    cursor = nextCursor;
    if (nextCursor === null || documents.length === 0) {
      break;
    }
  }

  await scopedDb((tx) => {
    // audit: skip — background legislation ingestion; cursor advance
    return tx
      .update(legislationSources)
      .set({ syncCursor: cursor, lastSyncAt: new Date() })
      .where(eq(legislationSources.id, source.id));
  });

  return { inserted, skipped, nextCursor: cursor };
};
