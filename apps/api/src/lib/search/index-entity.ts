import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { entities, extractedContent } from "@/api/db/schema";
import type { LinkMetadata, searchDocuments } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { compareCodepoint } from "@/api/lib/collation";
import { decryptContent } from "@/api/lib/content-encryption";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { selectCurrentExtractedContent } from "@/api/lib/document-content-provenance";
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
  "sourceEntityVersionId" | "sourceFieldId" | "sourceFileId" | "sourceSha256Hex"
> & {
  /**
   * `extracted_at` rendered by Postgres, never a JS `Date`. The column
   * defaults to `now()`, so a `Date` round-trip drops its microseconds and
   * the upsert's provenance fence would then never match — making every
   * re-index of the entity a silent no-op. `null` when the row was created
   * after the token was read, which fails the fence closed.
   */
  extractedAtToken: TimestampCasToken | null;
};

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
    case "money":
      // The amount is searchable in minor units; the currency code is what a
      // reader is likely to type ("EUR").
      return `${content.amountCents} ${content.currency}`;
    case "person":
      return content.name;
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
  database: Pick<typeof rootDb, "query" | "select">,
): Promise<BuiltSearchDocument | null> => {
  // The CAS tokens must be rendered to text by Postgres: a JS Date round-trip
  // truncates microseconds and the upsert's compare-at-full-precision guard
  // would then never match. A core select is used because the relational
  // builder's `extras` emits the column into SQL but drops it from the mapped
  // row (and its object form emits an unaliased reference the database
  // rejects). Reading the tokens in a separate query is safe: the upsert
  // re-checks version and tokens under FOR UPDATE, so a concurrent update
  // makes the CAS miss and the follow-up index event re-runs the build.
  // Both tokens are read BEFORE the projection they fence, so extraction
  // landing in between can only make the fence miss, never let stale text
  // through. `extracted_content.entity_id` is the primary key, so the
  // correlated read is scalar by construction.
  const [tokenRow] = await database
    .select({
      semanticUpdatedAtToken: sql<TimestampCasToken>`
        COALESCE(${entities.updatedAt}, ${entities.createdAt})::text
      `,
      extractedAtToken: sql<TimestampCasToken | null>`(
        SELECT ${timestampCasToken(extractedContent.extractedAt)}
        FROM extracted_content
        WHERE ${extractedContent.entityId} = ${entities.id}
      )`,
    })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  if (!tokenRow) {
    return null;
  }

  const entity = await database.query.entities.findFirst({
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
    with: {
      workspace: {
        columns: { organizationId: true },
      },
      currentVersion: {
        columns: { createdAt: true, id: true },
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
  const latestVersion = await database.query.entityVersions.findFirst({
    where: {
      entityId: { eq: entityId },
      workspaceId: { eq: entity.workspaceId },
    },
    columns: { id: true },
    // Include tombstones: a deleted newer version must keep legacy,
    // provenance-free text from being attributed to a promoted old version.
    orderBy: { versionNumber: "desc", id: "desc" },
  });

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
  const currentExtractedContent = selectCurrentExtractedContent({
    extracted: extractedContentRow,
    allowLegacy: latestVersion?.id === version.id,
    currentVersionCreatedAt: version.createdAt,
    currentVersionId: version.id,
    fields: version.fields,
  });
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
          extractedAtToken: tokenRow.extractedAtToken,
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
    semanticUpdatedAtToken: tokenRow.semanticUpdatedAtToken,
    updatedAt: entity.updatedAt ?? entity.createdAt,
  };
};

/**
 * Build a search document and upsert it into `search_documents`,
 * computing the `tsv` column with the per-document regconfig.
 */
// Postgres `text` and `tsvector` reject NUL (`\u0000`). Extracted document
// text reaches this boundary through encrypted `bytea`, which preserves NULs
// from binary-ish sources, so the projection write is the one place every
// producer funnels through — strip here, not at each producer.
const stripNulBytes = (text: string): string => text.replaceAll("\u0000", "");

export const upsertSearchDocument = async (
  entityId: SafeId<"entity">,
  {
    database = rootDb,
    syncActivity = syncWorkspaceSearchActivity,
  }: IndexEntityDependencies = {},
): Promise<void> => {
  const built = await buildSearchDocument(entityId, database);
  if (!built) {
    return;
  }
  const doc = {
    ...built,
    searchableText: stripNulBytes(built.searchableText),
    title: stripNulBytes(built.title),
  };

  const regconfig = doc.language ?? "simple";
  const previewGeneration = Bun.randomUUIDv7();
  const previewPassages = buildSearchPreviewPassages(
    doc.title,
    doc.searchableText,
  );
  const observedSource = doc.extractedContentSource;
  const hasObservedSource = observedSource !== null;

  await database.transaction(async (tx) => {
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
      INNER JOIN workspaces w ON w.id = e.workspace_id
      WHERE e.id = ${doc.entityId}
        AND w.organization_id = ${doc.organizationId}
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
                  IS NOT DISTINCT FROM ${observedSource?.extractedAtToken ?? null}::timestamptz
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
    await syncActivity(doc.workspaceId, tx);
  });
};

export type IndexEntityDependencies = {
  database?: Pick<typeof rootDb, "query" | "select" | "transaction">;
  syncActivity?: typeof syncWorkspaceSearchActivity;
};
