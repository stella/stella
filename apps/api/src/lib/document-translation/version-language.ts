/** The per-version document language written by native extraction. */

import { and, eq, isNull } from "drizzle-orm";

import type { DocumentTranslationSourceLanguageCode } from "@stll/api-contract/document-translation";

import type { Transaction } from "@/api/db/root";
import { entityVersions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type RecordEntityVersionDetectedLanguageOptions = {
  entityVersionId: SafeId<"entityVersion">;
  workspaceId: SafeId<"workspace">;
  language: DocumentTranslationSourceLanguageCode;
};

/**
 * Stamp the declared language on a version, first writer wins.
 *
 * The `IS NULL` predicate makes a redelivered extraction converge: a second
 * call is a no-op instead of a competing overwrite.
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
