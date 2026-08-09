import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

type ExtractedContentProvenance = {
  extractedAt: Date;
  sourceEntityVersionId: string | null;
  sourceFieldId: string | null;
  sourceFileId: string | null;
  sourceSha256Hex: string | null;
};

export type ExtractedContentSourceProvenance = Pick<
  ExtractedContentProvenance,
  "sourceEntityVersionId" | "sourceFieldId" | "sourceFileId" | "sourceSha256Hex"
>;

type FileFieldRow = {
  content: FieldContent | null;
  id: SafeId<"field">;
  propertyId?: SafeId<"property"> | undefined;
};

const findOnlyFileField = <T extends FileFieldRow>(
  fields: readonly T[],
): T | null => {
  const fileFields = fields.filter(({ content }) => content?.type === "file");
  return fileFields.length === 1 ? (fileFields.at(0) ?? null) : null;
};

export const resolveCurrentExtractionFileField = <T extends FileFieldRow>({
  currentVersionId,
  extracted,
  fields,
}: {
  currentVersionId: SafeId<"entityVersion">;
  extracted: ExtractedContentSourceProvenance | null | undefined;
  fields: readonly T[];
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
    return findOnlyFileField(fields);
  }

  const field = fields.find(
    ({ id }) =>
      extracted.sourceEntityVersionId === currentVersionId &&
      id === extracted.sourceFieldId,
  );
  return field?.content?.type === "file" &&
    field.content.id === extracted.sourceFileId &&
    field.content.sha256Hex === extracted.sourceSha256Hex
    ? field
    : null;
};

/**
 * Resolve the current file that live processing or direct reads may use.
 * Exact current provenance wins, including a non-first file property. While a
 * replacement version is awaiting extraction, its persisted provenance still
 * names the previous version; only a single current file is then unambiguous.
 * Same-version identity mismatches remain invalid instead of guessing.
 */
export const resolveCurrentFileSourceField = <T extends FileFieldRow>({
  currentVersionId,
  extracted,
  fields,
}: {
  currentVersionId: SafeId<"entityVersion">;
  extracted: ExtractedContentSourceProvenance | null | undefined;
  fields: readonly T[];
}): T | null => {
  if (!extracted) {
    return findOnlyFileField(fields);
  }

  const exactOrLegacySource = resolveCurrentExtractionFileField({
    currentVersionId,
    extracted,
    fields,
  });
  if (exactOrLegacySource) {
    return exactOrLegacySource;
  }

  const persistedSourceIsFromAnotherVersion =
    extracted.sourceEntityVersionId !== null &&
    extracted.sourceEntityVersionId !== currentVersionId;
  return persistedSourceIsFromAnotherVersion ? findOnlyFileField(fields) : null;
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
    content: FieldContent | null;
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
    return allowLegacy &&
      extracted.extractedAt >= currentVersionCreatedAt &&
      resolveCurrentExtractionFileField({
        currentVersionId,
        extracted,
        fields,
      })
      ? extracted
      : null;
  }

  return resolveCurrentExtractionFileField({
    currentVersionId,
    extracted,
    fields,
  })
    ? extracted
    : null;
};
