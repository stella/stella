import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { db } from "@/api/db/root";
import type { LinkMetadata, searchDocuments } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { docxReviewMarkupToSearchText } from "@/api/lib/docx-review-markup";
import { isoToRegconfig } from "@/api/lib/search/detect-language";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";
import { fileNameSearchText } from "@/api/lib/search/query";

type SearchDocumentRow = typeof searchDocuments.$inferInsert;

const linkMetadataSearchText = (metadata: LinkMetadata | null): string => {
  if (!metadata) {
    return "";
  }
  return [
    metadata.url,
    metadata.snippet,
    metadata.citation,
    metadata.jurisdiction,
    metadata.sourceType,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
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
      return content.fileName ? fileNameSearchText(content.fileName) : "";
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

const buildSearchDocument = async (
  entityId: SafeId<"entity">,
): Promise<SearchDocumentRow | null> => {
  const entity = await db.query.entities.findFirst({
    where: { id: { eq: entityId } },
    columns: {
      id: true,
      workspaceId: true,
      kind: true,
      name: true,
      metadata: true,
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
  let title = entity.name;

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
        title =
          field.content.type === "file"
            ? field.content.fileName
            : text.slice(0, 256);
      }
      fieldTexts.push(text);
    }
  }

  // Link entities carry their meaningful searchable bits (URL,
  // citation, jurisdiction, snippet, source type) in metadata.
  const linkText = linkMetadataSearchText(entity.metadata);
  if (linkText) {
    fieldTexts.push(linkText);
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
        fieldTexts.push(docxReviewMarkupToSearchText(plaintext));
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
 */
export const upsertSearchDocument = async (
  entityId: SafeId<"entity">,
): Promise<void> => {
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
        unaccent(
          coalesce(${doc.title}, '') || ' ' ||
          coalesce(${doc.searchableText}, '')
        )
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

  await syncWorkspaceSearchActivity(doc.workspaceId);
};
