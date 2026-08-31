/**
 * The per-version document language: the single write contract its two
 * producers share, and the matter-wide tally the translation dialog opens
 * with.
 *
 * Producers are native extraction (at ingestion, for every path that creates
 * a file version) and the translation-preparation endpoint (for versions that
 * predate the column). Both write through `recordEntityVersionDetectedLanguage`
 * so neither can overwrite the other and a redelivered job converges.
 */

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import {
  isDocumentTranslationSourceLanguageCode,
  type DocumentTranslationSourceLanguageCode,
} from "@stll/api-contract/document-translation";

import type { Transaction } from "@/api/db/root";
import { entities, entityVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/** How many languages the dialog is offered. Beyond this it is noise. */
export const MATTER_DOCUMENT_LANGUAGE_LIMIT = 5;

export type MatterDocumentLanguage = {
  language: DocumentTranslationSourceLanguageCode;
  count: number;
};

/** Drizzle types the grouped column nullable; the tally never is. */
type MatterDocumentLanguageRow = {
  language: string | null;
  count: number;
};

/**
 * Rank the grouped tally and keep the head of it. Ranking lives here rather
 * than in the SQL because a matter has at most one row per language in the
 * catalog, so ordering a few dozen rows in memory costs nothing and stays
 * testable. Ties break on the code so the dialog's default is deterministic.
 */
export const rankMatterDocumentLanguages = (
  rows: readonly MatterDocumentLanguageRow[],
): MatterDocumentLanguage[] =>
  rows
    .flatMap(({ language, count }) =>
      language !== null && isDocumentTranslationSourceLanguageCode(language)
        ? [{ language, count }]
        : [],
    )
    .toSorted(
      (first, second) =>
        // Codes, not display text: the tie-break only has to be stable, so a
        // locale collation would make it vary by caller for no gain.
        second.count - first.count ||
        (first.language < second.language ? -1 : 1),
    )
    .slice(0, MATTER_DOCUMENT_LANGUAGE_LIMIT);

type ReadMatterDocumentLanguagesOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  /** The document being translated: its own language is the source, not a hint. */
  excludeEntityId: SafeId<"entity">;
};

/**
 * Which languages the rest of this matter is written in.
 *
 * Only current versions count, and only ones that carry a detected language --
 * which is exactly the DOCX documents, since nothing else ever sets the
 * column. Scoped to one matter through `entities_workspace_id_idx`, with a
 * primary-key lookup per current version.
 */
export const readMatterDocumentLanguages = async ({
  tx,
  workspaceId,
  excludeEntityId,
}: ReadMatterDocumentLanguagesOptions): Promise<MatterDocumentLanguage[]> => {
  const rows = await tx
    .select({
      language: entityVersions.detectedLanguage,
      count: sql<number>`count(*)::int`,
    })
    .from(entities)
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, entities.currentVersionId),
        eq(entityVersions.workspaceId, entities.workspaceId),
      ),
    )
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        sql`${entities.id} <> ${excludeEntityId}`,
        isNull(entityVersions.deletedAt),
        isNotNull(entityVersions.detectedLanguage),
      ),
    )
    .groupBy(entityVersions.detectedLanguage);

  return rankMatterDocumentLanguages(rows);
};

type RecordEntityVersionDetectedLanguageOptions = {
  entityVersionId: SafeId<"entityVersion">;
  workspaceId: SafeId<"workspace">;
  language: DocumentTranslationSourceLanguageCode;
};

/**
 * Stamp the detected language on a version, first writer wins.
 *
 * The `IS NULL` predicate is what makes this safe to call from both producers
 * and from a redelivered extraction job: a second call is a no-op instead of a
 * competing overwrite.
 */
export const recordEntityVersionDetectedLanguage = async (
  db: Pick<Transaction, "update">,
  {
    entityVersionId,
    workspaceId,
    language,
  }: RecordEntityVersionDetectedLanguageOptions,
): Promise<void> => {
  await db
    .update(entityVersions)
    .set({ detectedLanguage: language })
    .where(
      and(
        eq(entityVersions.id, entityVersionId),
        eq(entityVersions.workspaceId, workspaceId),
        isNull(entityVersions.deletedAt),
        isNull(entityVersions.detectedLanguage),
      ),
    );
};
