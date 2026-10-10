import type { legalReaderAnnotations } from "@/api/db/schema";

type PrivateAnnotationExportRow = Pick<
  typeof legalReaderAnnotations.$inferSelect,
  | "id"
  | "targetType"
  | "targetId"
  | "groupId"
  | "kind"
  | "visibility"
  | "color"
  | "style"
  | "blockAnchorId"
  | "startOffset"
  | "endOffset"
  | "quote"
  | "body"
  | "createdAt"
  | "updatedAt"
>;

/** A user's private notes only; shared annotations remain organization data. */
export const projectPrivateAnnotationForAccountExport = (
  row: PrivateAnnotationExportRow,
) => {
  if (row.visibility !== "private") {
    return undefined;
  }
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    groupId: row.groupId,
    kind: row.kind,
    visibility: row.visibility,
    color: row.color,
    style: row.style,
    blockAnchorId: row.blockAnchorId,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    quote: row.quote,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};
