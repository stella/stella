import { panic } from "better-result";

import { db } from "@/api/db";
import type { searchDocuments } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";

type SearchDocumentRow = typeof searchDocuments.$inferInsert;

const extractFieldText = (content: FieldContent): string => {
  switch (content.type) {
    case "text":
      return content.value;
    case "single-select":
      return content.value ?? "";
    case "multi-select":
      return content.value.join(" ");
    case "date":
      return content.value ?? "";
    case "int":
      return String(content.value);
    case "file":
      return content.fileName;
    case "error":
    case "pending":
    case "unsupported":
      return "";
    default: {
      const _exhaustive: never = content;
      return _exhaustive;
    }
  }
};

export const buildSearchDocument = async (
  entityId: string,
): Promise<SearchDocumentRow | null> => {
  const entity = await db.query.entities.findFirst({
    where: { id: entityId },
    columns: {
      id: true,
      workspaceId: true,
      kind: true,
      name: true,
      updatedAt: true,
    },
    with: {
      workspace: {
        columns: { organizationId: true },
      },
      currentVersion: {
        columns: { id: true },
        with: {
          fields: {
            columns: { content: true, propertyId: true },
          },
        },
      },
    },
  });

  if (!entity) {
    return null;
  }

  const workspace = entity.workspace ?? panic("Entity has no workspace");
  const version =
    entity.currentVersion ?? panic("Entity has no currentVersion");

  const fieldTexts: string[] = [];
  let title = entity.name ?? "";

  // Sort by propertyId for deterministic title extraction
  const sortedFields = [...version.fields].sort((a, b) =>
    a.propertyId.localeCompare(b.propertyId),
  );

  for (const field of sortedFields) {
    const text = extractFieldText(field.content);
    if (text) {
      // Use file name or first text value as title fallback
      if (
        !title &&
        (field.content.type === "file" || field.content.type === "text")
      ) {
        title = text.slice(0, 256);
      }
      fieldTexts.push(text);
    }
  }

  return {
    entityId: entity.id,
    organizationId: workspace.organizationId,
    workspaceId: entity.workspaceId,
    kind: entity.kind,
    title,
    searchableText: fieldTexts.join(" "),
    updatedAt: entity.updatedAt ?? new Date(),
  };
};
