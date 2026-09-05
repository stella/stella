import { Result, TaggedError, UnhandledException } from "better-result";
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationDocuments,
  legislationSearchDocuments,
  legislationSources,
} from "@/api/db/schema";
import { redistributableLegislationSource } from "@/api/handlers/legislation/redistribution";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { setCorpusBackfillStatementTimeout } from "@/api/lib/legal-search/backfill-statement-timeout";
import { readCorpusText } from "@/api/lib/legal-search/corpus-storage";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { resolveFtsConfig } from "@/api/lib/legal-search/fts-config";
import { logger } from "@/api/lib/observability/logger";

/**
 * Postgres FTS projection for legislation, mirroring
 * case-law/search-index.ts: maintains `legislation_search_documents`
 * (tsvector) as a background backfill so the pre-corpus index search path
 * works for statutes too.
 */

const SEARCH_INDEX_CONCURRENCY = 4;
const CORPUS_READ_RETRY_DELAY_MS = 5 * 60_000;

class LegislationCorpusReadError extends TaggedError(
  "LegislationCorpusReadError",
)<{
  message: string;
  cause: unknown;
}> {}

const sectionsToPlainText = (
  sections: readonly DecisionSection[] | null,
): string => sections?.map((s) => s.text).join(" ") ?? "";

type LegislationSearchIndexDependencies = {
  readText: typeof readCorpusText;
  resolveConfig: typeof resolveFtsConfig;
};

const DEFAULT_DEPENDENCIES: LegislationSearchIndexDependencies = {
  readText: readCorpusText,
  resolveConfig: resolveFtsConfig,
};

export const indexLegislationDocument = async (
  documentId: SafeId<"legislationDocument">,
  scopedDb: ScopedDb,
  {
    readText,
    resolveConfig,
  }: LegislationSearchIndexDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> => {
  const [document] = await scopedDb((tx) =>
    tx
      .select({
        id: legislationDocuments.id,
        eli: legislationDocuments.eli,
        title: legislationDocuments.title,
        language: legislationDocuments.language,
        fulltext: legislationDocuments.fulltext,
        sections: legislationDocuments.sections,
        textS3Key: legislationDocuments.textS3Key,
      })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          eq(legislationDocuments.id, documentId),
          redistributableLegislationSource,
        ),
      )
      .limit(1),
  );

  if (!document) {
    await removeLegislationFromIndex(documentId, scopedDb);
    return;
  }

  let bodyText: string;
  let corpusReadFailure: { cause: unknown } | undefined;
  if (document.fulltext !== null) {
    bodyText = document.fulltext;
  } else if (document.sections !== null) {
    bodyText = sectionsToPlainText(document.sections);
  } else if (document.textS3Key !== null) {
    const textS3Key = document.textS3Key;
    const corpusRead = await Result.tryPromise(
      async () => await readText(textS3Key),
    );
    if (Result.isOk(corpusRead)) {
      bodyText = corpusRead.value;
    } else {
      bodyText = "";
      const cause =
        corpusRead.error instanceof UnhandledException
          ? corpusRead.error.cause
          : corpusRead.error;
      corpusReadFailure = { cause };
    }
  } else {
    bodyText = "";
  }

  const searchableText = [document.eli, document.title, bodyText]
    .filter(Boolean)
    .join(" ");

  const fts = await resolveConfig(document.language);

  const textExpr = fts.useUnaccent
    ? sql`unaccent(arabic_normalize(coalesce(${document.title}, '') || ' ' || coalesce(${searchableText}, '')))`
    : sql`arabic_normalize(coalesce(${document.title}, '') || ' ' || coalesce(${searchableText}, ''))`;
  const tsvExpr = sql`to_tsvector(${fts.regconfig}, ${textExpr})`;
  const retryAfterExpr =
    corpusReadFailure === undefined
      ? sql`NULL`
      : sql`now() + (${CORPUS_READ_RETRY_DELAY_MS} * interval '1 millisecond')`;

  await scopedDb(async (tx) => {
    await setCorpusBackfillStatementTimeout(tx);
    await tx.execute(sql`
    INSERT INTO legislation_search_documents (
      document_id, title, searchable_text,
      language, regconfig, updated_at, retry_after, tsv
    ) VALUES (
      ${document.id},
      ${document.title},
      ${searchableText},
      ${document.language},
      ${fts.regconfig},
      now(),
      ${retryAfterExpr},
      ${tsvExpr}
    )
    ON CONFLICT (document_id) DO UPDATE SET
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      language = EXCLUDED.language,
      regconfig = EXCLUDED.regconfig,
      updated_at = EXCLUDED.updated_at,
      retry_after = EXCLUDED.retry_after,
      tsv = EXCLUDED.tsv
  `);
  });

  if (corpusReadFailure !== undefined) {
    throw new LegislationCorpusReadError({
      message: "Canonical legislation corpus payload is unavailable",
      cause: corpusReadFailure.cause,
    });
  }
};

type LegislationSearchIndexBackfillResult = { found: number; indexed: number };

export const backfillLegislationSearchIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
  dependencies: LegislationSearchIndexDependencies = DEFAULT_DEPENDENCIES,
): Promise<LegislationSearchIndexBackfillResult> => {
  const staleReserved = Math.max(1, Math.floor(batchSize / 4));
  const missingLimit = Math.max(1, batchSize - staleReserved);

  const missing = await scopedDb((tx) =>
    tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          redistributableLegislationSource,
          notExists(
            tx
              .select({ one: sql`1` })
              .from(legislationSearchDocuments)
              .where(
                eq(
                  legislationSearchDocuments.documentId,
                  legislationDocuments.id,
                ),
              ),
          ),
        ),
      )
      .orderBy(
        asc(legislationDocuments.updatedAt),
        asc(legislationDocuments.id),
      )
      .limit(missingLimit),
  );

  const staleLimit = batchSize - missing.length;
  const stale = await scopedDb((tx) =>
    tx
      .select({ id: legislationDocuments.id })
      .from(legislationDocuments)
      .innerJoin(
        legislationSearchDocuments,
        eq(legislationSearchDocuments.documentId, legislationDocuments.id),
      )
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(
        and(
          redistributableLegislationSource,
          or(
            and(
              isNull(legislationSearchDocuments.retryAfter),
              gt(
                legislationDocuments.updatedAt,
                // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- column-to-column comparison evaluated in Postgres; no JS Date is bound
                legislationSearchDocuments.updatedAt,
              ),
            ),
            and(
              isNotNull(legislationSearchDocuments.retryAfter),
              lte(legislationSearchDocuments.retryAfter, sql`now()`),
            ),
          ),
        ),
      )
      .orderBy(
        asc(legislationDocuments.updatedAt),
        asc(legislationDocuments.id),
      )
      .limit(staleLimit),
  );

  const rows = [...missing, ...stale];

  const indexRow = async (row: {
    id: SafeId<"legislationDocument">;
  }): Promise<number> => {
    try {
      await indexLegislationDocument(row.id, scopedDb, dependencies);
      return 1;
    } catch (error) {
      captureError(error, {
        documentId: row.id,
        step: "backfillLegislationSearchIndex",
      });
      logger.error("legislation.search_index.backfill_failed", {
        documentId: row.id,
      });
      return 0;
    }
  };

  let indexed = 0;
  for (let i = 0; i < rows.length; i += SEARCH_INDEX_CONCURRENCY) {
    const chunk = rows.slice(i, i + SEARCH_INDEX_CONCURRENCY);
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded concurrency: each SEARCH_INDEX_CONCURRENCY chunk drains before the next so tsvector upserts don't overwhelm Postgres
    const results = await Promise.all(chunk.map(indexRow));
    for (const result of results) {
      indexed += result;
    }
  }

  return { found: rows.length, indexed };
};

export const removeLegislationFromIndex = async (
  documentId: SafeId<"legislationDocument">,
  scopedDb: ScopedDb,
): Promise<void> => {
  // eslint-disable-next-line arrow-body-style -- block body holds the audit-skip directive that the require-audit-on-mutation rule scans for inside this arrow's body range
  await scopedDb((tx) => {
    // audit: skip — search index maintenance; rebuilds derived state
    return tx
      .delete(legislationSearchDocuments)
      .where(eq(legislationSearchDocuments.documentId, documentId));
  });
};
