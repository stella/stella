import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { entities } from "@/api/db/schema";
import type {
  extractedContent,
  LinkMetadata,
  searchDocuments,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { compareCodepoint } from "@/api/lib/collation";
import { decryptContent } from "@/api/lib/content-encryption";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { docxReviewMarkupToSearchText } from "@/api/lib/docx-review-markup";
import { isoToRegconfig } from "@/api/lib/search/detect-language";
import { syncWorkspaceSearchActivity } from "@/api/lib/search/index-global";
import {
  buildSearchPreviewPassages,
  buildSearchPreviewPassageValueRows,
} from "@/api/lib/search/preview-passages";
import { fileNameSearchText } from "@/api/lib/search/query";

type SearchDocumentRow = typeof searchDocuments.$inferInsert;
type ExtractedContentSource = Pick<
  typeof extractedContent.$inferSelect,
  | "extractedAt"
  | "sourceEntityVersionId"
  | "sourceFieldId"
  | "sourceFileId"
  | "sourceSha256Hex"
>;

type BuiltSearchDocument = Omit<
  SearchDocumentRow,
  "searchableText" | "title"
> & {
  extractedContentSource: ExtractedContentSource | null;
  searchableText: string;
  semanticUpdatedAtToken: TimestampCasToken;
  sourceVersionId: SafeId<"entityVersion">;
  title: string;
};

type IndexedSearchDocument = {
  entityId: SafeId<"entity">;
};

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
): Promise<BuiltSearchDocument | null> => {
  const entity = await rootDb.query.entities.findFirst({
    where: { id: { eq: entityId } },
    columns: {
      id: true,
      workspaceId: true,
      kind: true,
      name: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
    },
    extras: {
      semanticUpdatedAtToken: sql<TimestampCasToken>`
        COALESCE(${entities.updatedAt}, ${entities.createdAt})::text
      `.as("semantic_updated_at_token"),
    },
    with: {
      workspace: {
        columns: { organizationId: true },
      },
      currentVersion: {
        columns: { id: true },
        with: {
          fields: {
            columns: { content: true, id: true, propertyId: true },
          },
        },
      },
      extractedContent: {
        columns: {
          ciphertext: true,
          extractedAt: true,
          iv: true,
          language: true,
          sourceEntityVersionId: true,
          sourceFieldId: true,
          sourceFileId: true,
          sourceSha256Hex: true,
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

  // Sort by propertyId (an internal id) for deterministic title extraction
  const sortedFields = [...version.fields].toSorted((a, b) =>
    compareCodepoint(a.propertyId, b.propertyId),
  );

  for (const field of sortedFields) {
    const text = extractFieldText(field.content);
    if (text) {
      // Use file name or first text value as title fallback
      const content = field.content;
      if (!title && (content.type === "file" || content.type === "text")) {
        title = content.type === "file" ? content.fileName : text.slice(0, 256);
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

  const extractedContentRow = entity.extractedContent;
  const isLegacyExtractedContent =
    extractedContentRow?.sourceEntityVersionId === null &&
    extractedContentRow.sourceFieldId === null &&
    extractedContentRow.sourceFileId === null &&
    extractedContentRow.sourceSha256Hex === null;
  const currentExtractedContent =
    extractedContentRow &&
    (isLegacyExtractedContent ||
      (extractedContentRow.sourceEntityVersionId === version.id &&
        version.fields.some(
          (field) =>
            field.id === extractedContentRow.sourceFieldId &&
            field.content.type === "file" &&
            field.content.id === extractedContentRow.sourceFileId &&
            field.content.sha256Hex === extractedContentRow.sourceSha256Hex,
        )))
      ? extractedContentRow
      : null;
  if (currentExtractedContent) {
    const { ciphertext, iv } = currentExtractedContent;
    language = isoToRegconfig(currentExtractedContent.language);
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
      // Keep the last complete projection until re-extraction fixes it.
      captureError(error, { entityId });
      throw error;
    }
  }

  return {
    entityId: entity.id,
    extractedContentSource: extractedContentRow
      ? {
          extractedAt: extractedContentRow.extractedAt,
          sourceEntityVersionId: extractedContentRow.sourceEntityVersionId,
          sourceFieldId: extractedContentRow.sourceFieldId,
          sourceFileId: extractedContentRow.sourceFileId,
          sourceSha256Hex: extractedContentRow.sourceSha256Hex,
        }
      : null,
    organizationId: workspace.organizationId,
    workspaceId: entity.workspaceId,
    kind: entity.kind,
    title,
    searchableText: fieldTexts.join(" "),
    language,
    sourceVersionId: version.id,
    semanticUpdatedAtToken: entity.semanticUpdatedAtToken,
    updatedAt: entity.updatedAt ?? entity.createdAt,
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
  const previewGeneration = Bun.randomUUIDv7();
  const previewPassages = buildSearchPreviewPassages(
    doc.title,
    doc.searchableText,
  );
  const observedSource = doc.extractedContentSource;
  const hasObservedSource = observedSource !== null;

  await rootDb.transaction(async (tx) => {
    // oxlint-disable-next-line require-search-scope/require-search-scope -- atomic INSERT SELECT fences one entity by explicit organization, workspace, entity, version, timestamp, and extracted-content provenance
    const indexed = await tx.execute<IndexedSearchDocument>(sql`
      INSERT INTO search_documents (
        entity_id, organization_id, workspace_id,
        kind, title, searchable_text, language,
        updated_at, tsv
      )
      SELECT
        ${doc.entityId},
        ${doc.organizationId},
        ${doc.workspaceId},
        ${doc.kind},
        ${doc.title},
        ${doc.searchableText},
        ${doc.language},
        ${doc.semanticUpdatedAtToken}::timestamptz,
        to_tsvector(
          ${regconfig}::regconfig,
          unaccent(arabic_normalize(
            coalesce(${doc.title}, '') || ' ' ||
            coalesce(${doc.searchableText}, '')
          ))
        )
      FROM entities e
      WHERE e.id = ${doc.entityId}
        AND e.organization_id = ${doc.organizationId}
        AND e.workspace_id = ${doc.workspaceId}
        AND e.current_version_id = ${doc.sourceVersionId}
        AND COALESCE(e.updated_at, e.created_at)
          IS NOT DISTINCT FROM ${doc.semanticUpdatedAtToken}::timestamptz
        AND (
          (
            ${hasObservedSource} = false
            AND NOT EXISTS (
              SELECT 1
              FROM extracted_content ec
              WHERE ec.entity_id = e.id
                AND ec.organization_id = ${doc.organizationId}
                AND ec.workspace_id = ${doc.workspaceId}
            )
          )
          OR
          (
            ${hasObservedSource} = true
            AND EXISTS (
              SELECT 1
              FROM extracted_content ec
              WHERE ec.entity_id = e.id
                AND ec.organization_id = ${doc.organizationId}
                AND ec.workspace_id = ${doc.workspaceId}
                AND ec.source_entity_version_id
                  IS NOT DISTINCT FROM ${observedSource?.sourceEntityVersionId ?? null}
                AND ec.source_field_id
                  IS NOT DISTINCT FROM ${observedSource?.sourceFieldId ?? null}
                AND ec.source_file_id
                  IS NOT DISTINCT FROM ${observedSource?.sourceFileId ?? null}
                AND ec.source_sha256_hex
                  IS NOT DISTINCT FROM ${observedSource?.sourceSha256Hex ?? null}
                AND ec.extracted_at
                  IS NOT DISTINCT FROM ${observedSource?.extractedAt ?? null}
            )
          )
        )
      FOR UPDATE OF e
      ON CONFLICT (entity_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        workspace_id = EXCLUDED.workspace_id,
        kind = EXCLUDED.kind,
        title = EXCLUDED.title,
        searchable_text = EXCLUDED.searchable_text,
        language = EXCLUDED.language,
        updated_at = EXCLUDED.updated_at,
        tsv = EXCLUDED.tsv
      RETURNING entity_id AS "entityId"
    `);

    if (!indexed.at(0)) {
      return;
    }
    await tx.execute(sql`
      DELETE FROM search_document_preview_passages
      WHERE entity_id = ${doc.entityId}
    `);
    await tx.execute(sql`
      INSERT INTO search_document_preview_passages (
        entity_id, organization_id, workspace_id,
        generation, ordinal, content, tsv
      ) VALUES ${buildSearchPreviewPassageValueRows({
        generation: previewGeneration,
        leadingValues: [
          sql`${doc.entityId}`,
          sql`${doc.organizationId}`,
          sql`${doc.workspaceId}`,
        ],
        passages: previewPassages,
        regconfig: sql`${regconfig}`,
        useUnaccent: true,
      })}
    `);
    await tx.execute(sql`
      UPDATE search_documents
      SET preview_generation = ${previewGeneration}::uuid
      WHERE entity_id = ${doc.entityId}
    `);
    await syncWorkspaceSearchActivity(doc.workspaceId, tx);
  });
};
