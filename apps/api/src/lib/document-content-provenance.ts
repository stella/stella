import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { findExtractionFileField } from "@/api/lib/search/types";

type ExtractedContentProvenance = {
  extractedAt: Date;
  sourceEntityVersionId: string | null;
  sourceFieldId: string | null;
  sourceFileId: string | null;
  sourceSha256Hex: string | null;
};

/**
 * Return an extracted-content projection only when it describes the current
 * immutable file source. Legacy rows predate provenance columns; accept them
 * only when the current version is still the newest version and their
 * extraction timestamp is at least as new as that version. The newest-version
 * fence prevents a deleted-version rollback from serving the withdrawn text.
 */
export const selectCurrentExtractedContent = <
  T extends ExtractedContentProvenance,
>({
  extracted,
  allowLegacy,
  currentVersionCreatedAt,
  currentVersionId,
  fields,
}: {
  extracted: T | null | undefined;
  /** False when a deleted/newer version proves the current version is a rollback. */
  allowLegacy: boolean;
  currentVersionCreatedAt: Date;
  currentVersionId: SafeId<"entityVersion">;
  fields: readonly {
    content: FieldContent;
    id: SafeId<"field">;
    propertyId?: SafeId<"property"> | undefined;
  }[];
}): T | null => {
  if (!extracted) {
    return null;
  }

  const legacySource =
    extracted.sourceEntityVersionId === null &&
    extracted.sourceFieldId === null &&
    extracted.sourceFileId === null &&
    extracted.sourceSha256Hex === null;
  if (legacySource) {
    return allowLegacy && extracted.extractedAt >= currentVersionCreatedAt
      ? extracted
      : null;
  }

  const file = findExtractionFileField(fields);
  const field = fields.find(
    (candidate) =>
      candidate.id === extracted.sourceFieldId &&
      candidate.content.type === "file" &&
      candidate.content.id === file?.id,
  );
  return extracted.sourceEntityVersionId === currentVersionId &&
    field?.content.type === "file" &&
    field.content.id === extracted.sourceFileId &&
    field.content.sha256Hex === extracted.sourceSha256Hex
    ? extracted
    : null;
};
