import { and, asc, eq, gt, notExists, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import {
  legislationDocuments,
  legislationSearchDocuments,
  legislationSources,
} from "@/api/db/schema";
import { resolveFtsConfig } from "@/api/handlers/case-law/fts-config";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";

/**
 * Postgres FTS projection for legislation, mirroring
 * case-law/search-index.ts: maintains `legislation_search_documents`
 * (tsvector) as a background backfill so the pre-corpus index search path
 * works for statutes too.
 */

const SEARCH_INDEX_CONCURRENCY = 4;

const sectionsToPlainText = (
  sections: readonly DecisionSection[] | null,
): string => sections?.map((s) => s.text).join(" ") ?? "";

// Same redistribution gate as the corpus-index projection. null descriptor =
// legacy public source, treated as redistributable.
const redistributable = sql`(
  ${legislationSources.descriptor} IS NULL
  OR (${legislationSources.descriptor} ->> 'allowsRedistribution') = 'true'
)`;

export const indexLegislationDocument = async (
  documentId: SafeId<"legislationDocument">,
  scopedDb: ScopedDb,
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
      })
      .from(legislationDocuments)
      .innerJoin(
        legislationSources,
        eq(legislationSources.id, legislationDocuments.sourceId),
      )
      .where(and(eq(legislationDocuments.id, documentId), redistributable))
      .limit(1),
  );

  if (!document) {
    await removeLegislationFromIndex(documentId, scopedDb);
    return;
  }

  const bodyText =
    document.fulltext ??
    // SAFETY: sections is typed unknown in Drizzle's JSONB column but is
    // always DecisionSection[] | null when set by ingestion.
    sectionsToPlainText(document.sections);

  const searchableText = [document.eli, document.title, bodyText]
    .filter(Boolean)
    .join(" ");

  const fts = await resolveFtsConfig(document.language);

  const textExpr = fts.useUnaccent
    ? sql`unaccent(coalesce(${document.title}, '') || ' ' || coalesce(${searchableText}, ''))`
    : sql`coalesce(${document.title}, '') || ' ' || coalesce(${searchableText}, '')`;
  const tsvExpr = sql`to_tsvector(${fts.regconfig}, ${textExpr})`;

  await scopedDb(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '15min'`);
    await tx.execute(sql`
    INSERT INTO legislation_search_documents (
      document_id, title, searchable_text,
      language, regconfig, updated_at, tsv
    ) VALUES (
      ${document.id},
      ${document.title},
      ${searchableText},
      ${document.language},
      ${fts.regconfig},
      now(),
      ${tsvExpr}
    )
    ON CONFLICT (document_id) DO UPDATE SET
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      language = EXCLUDED.language,
      regconfig = EXCLUDED.regconfig,
      updated_at = EXCLUDED.updated_at,
      tsv = EXCLUDED.tsv
  `);
  });
};

export const backfillLegislationSearchIndex = async (
  scopedDb: ScopedDb,
  batchSize: number,
): Promise<number> => {
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
          redistributable,
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
      .orderBy(asc(legislationDocuments.createdAt))
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
          redistributable,
          gt(
            legislationDocuments.updatedAt,
            legislationSearchDocuments.updatedAt,
          ),
        ),
      )
      .orderBy(asc(legislationDocuments.createdAt))
      .limit(staleLimit),
  );

  const rows = [...missing, ...stale];

  const indexRow = async (row: {
    id: SafeId<"legislationDocument">;
  }): Promise<number> => {
    try {
      await indexLegislationDocument(row.id, scopedDb);
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
    const results = await Promise.all(chunk.map(indexRow));
    for (const result of results) {
      indexed += result;
    }
  }

  return indexed;
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
