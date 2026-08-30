import type { FieldContent } from "@/api/db/schema-validators";

type FileFieldContent = Extract<FieldContent, { type: "file" }>;

export type DeletionFileFieldRow = {
  content: FieldContent;
  entityVersionId: string;
  id: string;
};

/**
 * Selects the same canonical file field as activity reads: the first file by
 * field ID on each entity's current version. The input is sorted here as well
 * as in the database query so the invariant is independent of row order.
 */
export const selectCanonicalFileContents = (
  fieldRows: readonly DeletionFileFieldRow[],
  entityIdByCurrentVersionId: ReadonlyMap<string, string>,
): Map<string, FileFieldContent> => {
  const currentFileByEntityId = new Map<string, FileFieldContent>();
  const orderedFieldRows = fieldRows.toSorted((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  for (const { content, entityVersionId } of orderedFieldRows) {
    const entityId = entityIdByCurrentVersionId.get(entityVersionId);
    if (
      content.type !== "file" ||
      entityId === undefined ||
      currentFileByEntityId.has(entityId)
    ) {
      continue;
    }
    currentFileByEntityId.set(entityId, content);
  }

  return currentFileByEntityId;
};
