import { and, eq, isNull } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import type { documentProcessingRuns } from "@/api/db/schema";
import {
  entities,
  entityVersions,
  extractedContent,
  fields as sourceFields,
  workspaces,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

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

type LoadCurrentExtractedContentsOptions = {
  entityIds: SafeId<"entity">[];
  organizationId: SafeId<"organization">;
  workspaceIds?: SafeId<"workspace">[];
};

export const loadCurrentExtractedContents = async (
  database: Pick<typeof rootDb, "query">,
  {
    entityIds,
    organizationId,
    workspaceIds,
  }: LoadCurrentExtractedContentsOptions,
) => {
  if (entityIds.length === 0 || workspaceIds?.length === 0) {
    return [];
  }
  const rows = await database.query.extractedContent.findMany({
    where: {
      entityId: { in: entityIds },
      organizationId: { eq: organizationId },
      workspaceId: workspaceIds ? { in: workspaceIds } : undefined,
    },
    columns: {
      entityId: true,
      workspaceId: true,
      ciphertext: true,
      iv: true,
      charCount: true,
      language: true,
      extractedAt: true,
      sourceEntityVersionId: true,
      sourceFieldId: true,
      sourceFileId: true,
      sourceSha256Hex: true,
      ocrRunId: true,
    },
    with: {
      entity: {
        columns: { name: true, workspaceId: true },
        with: {
          workspace: { columns: { status: true } },
          currentVersion: {
            columns: { id: true, createdAt: true, deletedAt: true },
            with: {
              fields: {
                columns: { id: true, content: true },
                limit: LIMITS.propertiesCount,
              },
            },
          },
          versions: {
            columns: { id: true },
            orderBy: { versionNumber: "desc", id: "desc" },
            limit: 1,
          },
        },
      },
    },
    limit: entityIds.length,
  });
  return rows.flatMap((row) => {
    const entity = row.entity;
    const version = entity?.currentVersion;
    if (
      !entity ||
      !version ||
      version.deletedAt !== null ||
      entity.workspace?.status === "deleting"
    ) {
      return [];
    }
    const current = selectCurrentExtractedContent({
      extracted: row,
      allowLegacy: entity.versions.at(0)?.id === version.id,
      currentVersionCreatedAt: version.createdAt,
      currentVersionId: version.id,
      fields: version.fields,
    });
    return current ? [{ ...current, name: entity.name }] : [];
  });
};

type CurrentExtractionReadDb = Pick<typeof rootDb, "select">;

type LoadCurrentOcrExportOptions = {
  db: CurrentExtractionReadDb;
  fieldId: SafeId<"field">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

export const loadCurrentOcrExport = async ({
  db,
  fieldId,
  organizationId,
  workspaceId,
}: LoadCurrentOcrExportOptions) => {
  const rows = await db
    .select({
      ciphertext: extractedContent.ciphertext,
      entityId: entities.id,
      content: sourceFields.content,
      iv: extractedContent.iv,
      ocrRunId: extractedContent.ocrRunId,
      sourceFileId: extractedContent.sourceFileId,
      sourceSha256Hex: extractedContent.sourceSha256Hex,
    })
    .from(extractedContent)
    .innerJoin(
      entities,
      and(
        eq(entities.id, extractedContent.entityId),
        eq(entities.workspaceId, workspaceId),
        eq(entities.currentVersionId, extractedContent.sourceEntityVersionId),
      ),
    )
    .innerJoin(
      entityVersions,
      and(
        eq(entityVersions.id, extractedContent.sourceEntityVersionId),
        eq(entityVersions.entityId, entities.id),
        eq(entityVersions.workspaceId, workspaceId),
        isNull(entityVersions.deletedAt),
      ),
    )
    .innerJoin(
      sourceFields,
      and(
        eq(sourceFields.id, fieldId),
        eq(sourceFields.id, extractedContent.sourceFieldId),
        eq(sourceFields.entityVersionId, entityVersions.id),
        eq(sourceFields.workspaceId, workspaceId),
      ),
    )
    .where(
      and(
        eq(extractedContent.organizationId, organizationId),
        eq(extractedContent.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  const row = rows.at(0);
  if (
    !row ||
    row.content.type !== "file" ||
    row.content.id !== row.sourceFileId ||
    row.content.sha256Hex !== row.sourceSha256Hex
  ) {
    return null;
  }
  return row;
};

type DeadlineSourceRun = typeof documentProcessingRuns.$inferSelect;

const currentSourceWhere = (run: DeadlineSourceRun) =>
  and(
    eq(extractedContent.entityId, run.entityId),
    eq(extractedContent.organizationId, run.organizationId),
    eq(extractedContent.workspaceId, run.workspaceId),
    eq(extractedContent.sourceEntityVersionId, run.entityVersionId),
    eq(extractedContent.sourceFieldId, run.fieldId),
    eq(extractedContent.sourceFileId, run.sourceFileId),
    eq(extractedContent.sourceSha256Hex, run.sourceSha256Hex),
    run.kind === "ocr"
      ? eq(extractedContent.ocrRunId, run.id)
      : isNull(extractedContent.ocrRunId),
    eq(entities.currentVersionId, run.entityVersionId),
    eq(workspaces.status, "active"),
  );

export const loadCurrentDeadlineSource = async (
  db: CurrentExtractionReadDb,
  run: DeadlineSourceRun,
) => {
  const rows = await db
    .select({
      ciphertext: extractedContent.ciphertext,
      entityName: entities.name,
      iv: extractedContent.iv,
    })
    .from(extractedContent)
    .innerJoin(
      entities,
      and(
        eq(entities.id, extractedContent.entityId),
        eq(entities.workspaceId, extractedContent.workspaceId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, extractedContent.workspaceId),
        eq(workspaces.organizationId, extractedContent.organizationId),
      ),
    )
    .where(currentSourceWhere(run))
    .limit(1);
  return rows.at(0) ?? null;
};

export const isCurrentDeadlineSource = async (
  db: CurrentExtractionReadDb,
  run: DeadlineSourceRun,
) => {
  const current = await db
    .select({ entityId: extractedContent.entityId })
    .from(extractedContent)
    .innerJoin(
      entities,
      and(
        eq(entities.id, extractedContent.entityId),
        eq(entities.workspaceId, extractedContent.workspaceId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, extractedContent.workspaceId),
        eq(workspaces.organizationId, extractedContent.organizationId),
      ),
    )
    .where(currentSourceWhere(run))
    .limit(1);
  return current.length === 1;
};
