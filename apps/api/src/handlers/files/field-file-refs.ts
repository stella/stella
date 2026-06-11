import { and, eq, inArray, not, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { entityVersions, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { THUMBNAIL_MIME_TYPE } from "@/api/handlers/files/image-derivative";
import type { SafeId } from "@/api/lib/branded-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export type FieldFileRef = { fileId: string; mimeType: string };

export const extractFieldFileRefs = (content: FieldContent): FieldFileRef[] => {
  if (content.type !== "file") {
    return [];
  }

  const refs: FieldFileRef[] = [
    { fileId: content.id, mimeType: content.mimeType },
  ];

  if (content.pdfFileId) {
    refs.push({
      fileId: content.pdfFileId,
      mimeType: PDF_MIME_TYPE,
    });
  }

  if (content.thumbnailFileId) {
    refs.push({
      fileId: content.thumbnailFileId,
      mimeType: THUMBNAIL_MIME_TYPE,
    });
  }

  return refs;
};

type FilterUnreferencedFieldFileRefsOptions = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  fileRows: FieldFileRef[];
  excludedEntityIds?: SafeId<"entity">[];
  excludedEntityVersionIds?: SafeId<"entityVersion">[];
};

export const filterUnreferencedFieldFileRefs = async ({
  tx,
  workspaceId,
  fileRows,
  excludedEntityIds = [],
  excludedEntityVersionIds = [],
}: FilterUnreferencedFieldFileRefsOptions): Promise<FieldFileRef[]> => {
  if (fileRows.length === 0) {
    return [];
  }

  const fileIds = [...new Set(fileRows.map((row) => row.fileId))];
  const liveFileRows = await tx
    .select({ content: fields.content })
    .from(fields)
    .innerJoin(entityVersions, eq(fields.entityVersionId, entityVersions.id))
    .where(
      and(
        eq(fields.workspaceId, workspaceId),
        sql`${fields.content}->>'type' = 'file'`,
        or(
          inArray(sql<string>`${fields.content}->>'id'`, fileIds),
          inArray(sql<string>`${fields.content}->>'pdfFileId'`, fileIds),
          inArray(sql<string>`${fields.content}->>'thumbnailFileId'`, fileIds),
        ),
        ...(excludedEntityIds.length > 0
          ? [not(inArray(entityVersions.entityId, excludedEntityIds))]
          : []),
        ...(excludedEntityVersionIds.length > 0
          ? [not(inArray(entityVersions.id, excludedEntityVersionIds))]
          : []),
      ),
    );

  const liveFileIds = new Set(
    liveFileRows.flatMap((row) =>
      extractFieldFileRefs(row.content).map((ref) => ref.fileId),
    ),
  );

  return fileRows.filter((row) => !liveFileIds.has(row.fileId));
};
