import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { db } from "@/api/db";
import type { searchDocuments } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics";
import { decryptContent } from "@/api/lib/content-encryption";
import { isoToRegconfig } from "@/api/lib/search/detect-language";

type SearchDocumentRow = typeof searchDocuments.$inferInsert;

/** Normalize file names for search: strip extension,
 *  replace underscores/hyphens with spaces. */
const normalizeFileName = (name: string): string => {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  return base.replace(/[_-]+/g, " ");
};

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
      return content.fileName ? normalizeFileName(content.fileName) : "";
    case "error":
    case "pending":
    case "unsupported":
    case "clip":
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
      extractedContent: {
        columns: {
          ciphertext: true,
          iv: true,
          language: true,
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
  const sortedFields = [...version.fields].toSorted((a, b) =>
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

  // Append decrypted file content when available.
  // Store the PG regconfig name (not ISO code) so the
  // FTS provider can use it directly.
  let language: string | null = null;

  if (entity.extractedContent) {
    const { ciphertext, iv } = entity.extractedContent;
    language = isoToRegconfig(entity.extractedContent.language);
    try {
      const plaintext = await decryptContent(
        workspace.organizationId,
        ciphertext,
        iv,
      );
      if (plaintext) {
        fieldTexts.push(plaintext);
      }
    } catch (error) {
      // Decryption fails when CONTENT_ENCRYPTION_KEY was
      // added or rotated after this content was stored.
      // Skip extracted content; re-extract to fix.
      captureError(error, { entityId });
    }
  }

  return {
    entityId: entity.id,
    organizationId: workspace.organizationId,
    workspaceId: entity.workspaceId,
    kind: entity.kind,
    title,
    searchableText: fieldTexts.join(" "),
    language,
    updatedAt: entity.updatedAt ?? new Date(),
  };
};

/**
 * Build a search document and upsert it into `search_documents`,
 * computing the `tsv` column with the per-document regconfig.
 * Shared by both pg-fts and paradedb providers so the tsvector
 * is always populated regardless of the active provider.
 */
export const upsertSearchDocument = async (entityId: string): Promise<void> => {
  const doc = await buildSearchDocument(entityId);
  if (!doc) {
    return;
  }

  const regconfig = doc.language ?? "simple";

  await db.execute(sql`
    INSERT INTO search_documents (
      entity_id, organization_id, workspace_id,
      kind, title, searchable_text, language,
      updated_at, tsv
    ) VALUES (
      ${doc.entityId},
      ${doc.organizationId},
      ${doc.workspaceId},
      ${doc.kind},
      ${doc.title},
      ${doc.searchableText},
      ${doc.language},
      now(),
      to_tsvector(
        ${regconfig}::regconfig,
        coalesce(${doc.title}, '') || ' ' ||
        coalesce(${doc.searchableText}, '')
      )
    )
    ON CONFLICT (entity_id) DO UPDATE SET
      organization_id = EXCLUDED.organization_id,
      workspace_id = EXCLUDED.workspace_id,
      kind = EXCLUDED.kind,
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      language = EXCLUDED.language,
      updated_at = EXCLUDED.updated_at,
      tsv = EXCLUDED.tsv
  `);
};
