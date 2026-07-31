import { sql } from "drizzle-orm";

import {
  ENTITY_KINDS,
  bytea,
  jsonb,
  orgPolicies,
  orgReadOnlyPolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  tsvector,
  user,
  wsPolicies,
  wsOrganizationReadOnlyPolicies,
  timestamptz,
} from "./common";
import type { AnyPgColumn, TemplateManifest } from "./common";
import { contacts, workspaces } from "./contacts";
import { TEMPLATE_KINDS, entities, entityVersions, fields } from "./entities";

export const templateCategories = p.pgTable(
  "template_categories",
  {
    id: pUuid<"templateCategory">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    parentId: safeUuid<"templateCategory">("parent_id").references(
      (): AnyPgColumn => templateCategories.id,
      {
        onDelete: "set null",
      },
    ),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("template_categories_organization_id_idx").on(table.organizationId),
    p
      .index("template_categories_org_parent_idx")
      .on(table.organizationId, table.parentId),
    ...orgPolicies(),
  ],
);

export const templates = p.pgTable(
  "templates",
  {
    id: pUuid<"template">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    categoryId: safeUuid<"templateCategory">("category_id").references(
      (): AnyPgColumn => templateCategories.id,
      {
        onDelete: "set null",
      },
    ),
    name: p.varchar({ length: 256 }).notNull(),
    kind: p
      .text("kind", { enum: TEMPLATE_KINDS })
      .notNull()
      .default("document"),
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    s3Key: p.varchar("s3_key", { length: 512 }).notNull(),
    sizeBytes: p.integer("size_bytes").notNull(),
    manifest: jsonb().$type<TemplateManifest>(),
    fieldCount: p.integer("field_count").notNull().default(0),
    currentVersion: p.integer("current_version").notNull().default(1),
    tags: p.text().array(),
    /** Ordered BCP-47 tags of the document text (bilingual templates list
     *  every language, primary first). */
    languages: p.text().array().notNull().default([]),
    whenToUse: p.text("when_to_use"),
    whenNotToUse: p.text("when_not_to_use"),
    useCount: p.integer("use_count").notNull().default(0),
    lastUsedAt: timestamptz("last_used_at"),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("templates_organization_id_idx").on(table.organizationId),
    p
      .index("templates_organization_id_name_idx")
      .on(table.organizationId, table.name),
    p
      .index("templates_organization_id_created_at_idx")
      .on(table.organizationId, table.createdAt),
    p
      .index("templates_org_category_idx")
      .on(table.organizationId, table.categoryId),
    p.unique("templates_id_org_unq").on(table.id, table.organizationId),
    ...orgPolicies(),
  ],
);

export const templateVersions = p.pgTable(
  "template_versions",
  {
    id: pUuid<"templateVersion">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    templateId: safeUuid<"template">("template_id").notNull(),
    version: p.integer().notNull(),
    s3Key: p.varchar("s3_key", { length: 512 }).notNull(),
    manifest: jsonb().$type<TemplateManifest>(),
    fieldCount: p.integer("field_count").notNull().default(0),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("template_versions_template_version_uidx")
      .on(table.templateId, table.version),
    p.index("template_versions_template_id_idx").on(table.templateId),
    p
      .foreignKey({
        columns: [table.templateId, table.organizationId],
        foreignColumns: [templates.id, templates.organizationId],
      })
      .onDelete("cascade"),
    p.index("template_versions_organization_id_idx").on(table.organizationId),
    ...orgPolicies(),
  ],
);

// -- Search --

export const searchDocuments = p.pgTable(
  "search_documents",
  {
    entityId: safeUuid<"entity">("entity_id")
      .primaryKey()
      .references(() => entities.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: p.text("kind", { enum: ENTITY_KINDS }).notNull(),
    title: p.text().notNull().default(""),
    searchableText: p.text("searchable_text").notNull().default(""),
    language: p.varchar("language", { length: 10 }),
    previewGeneration: p.uuid("preview_generation"),
    tsv: tsvector(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("search_documents_org_id_idx").on(table.organizationId),
    p
      .index("search_documents_org_workspace_idx")
      .on(table.organizationId, table.workspaceId),
    p
      .index("search_documents_org_updated_id_idx")
      .on(table.organizationId, table.updatedAt.desc(), table.entityId.desc()),
    p.index("search_documents_tsv_idx").using("gin", table.tsv),
    ...wsPolicies(),
  ],
);

export const searchDocumentPreviewPassages = p.pgTable(
  "search_document_preview_passages",
  {
    entityId: safeUuid<"entity">("entity_id")
      .notNull()
      .references(() => searchDocuments.entityId, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id").notNull(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    generation: p.uuid().notNull(),
    ordinal: p.integer().notNull(),
    content: p.text().notNull(),
    tsv: tsvector().notNull(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.entityId, table.generation, table.ordinal],
      name: "search_document_preview_passages_pk",
    }),
    p
      .index("search_doc_preview_passages_scope_idx")
      .on(
        table.organizationId,
        table.workspaceId,
        table.entityId,
        table.generation,
        table.ordinal,
      ),
    p.index("search_doc_preview_passages_tsv_idx").using("gin", table.tsv),
    ...wsOrganizationReadOnlyPolicies("search_document_preview_passages"),
  ],
);

export const contactSearchDocuments = p.pgTable(
  "contact_search_documents",
  {
    contactId: safeUuid<"contact">("contact_id")
      .primaryKey()
      .references(() => contacts.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactType: p
      .text("contact_type", {
        enum: ["person", "organization"],
      })
      .notNull(),
    title: p.text().notNull().default(""),
    searchableText: p.text("searchable_text").notNull().default(""),
    previewGeneration: p.uuid("preview_generation"),
    tsv: tsvector(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("contact_search_docs_org_idx").on(table.organizationId),
    p
      .index("contact_search_docs_org_type_idx")
      .on(table.organizationId, table.contactType),
    p
      .index("contact_search_docs_org_updated_id_idx")
      .on(table.organizationId, table.updatedAt.desc(), table.contactId.desc()),
    p.index("contact_search_docs_tsv_idx").using("gin", table.tsv),
    ...orgPolicies(),
  ],
);

export const contactSearchDocumentPreviewPassages = p.pgTable(
  "contact_search_document_preview_passages",
  {
    contactId: safeUuid<"contact">("contact_id")
      .notNull()
      .references(() => contactSearchDocuments.contactId, {
        onDelete: "cascade",
      }),
    organizationId: safeOrganizationId("organization_id").notNull(),
    generation: p.uuid().notNull(),
    ordinal: p.integer().notNull(),
    content: p.text().notNull(),
    tsv: tsvector().notNull(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.contactId, table.generation, table.ordinal],
      name: "contact_search_document_preview_passages_pk",
    }),
    p
      .index("contact_preview_passages_scope_idx")
      .on(
        table.organizationId,
        table.contactId,
        table.generation,
        table.ordinal,
      ),
    p.index("contact_preview_passages_tsv_idx").using("gin", table.tsv),
    ...orgReadOnlyPolicies("contact_search_document_preview_passages"),
  ],
);

export const workspaceSearchDocuments = p.pgTable(
  "workspace_search_documents",
  {
    workspaceId: safeWorkspaceId("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: p.text().notNull().default(""),
    searchableText: p.text("searchable_text").notNull().default(""),
    previewGeneration: p.uuid("preview_generation"),
    tsv: tsvector(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("workspace_search_docs_org_idx").on(table.organizationId),
    p
      .index("workspace_search_docs_org_updated_id_idx")
      .on(
        table.organizationId,
        table.updatedAt.desc(),
        table.workspaceId.desc(),
      ),
    p.index("workspace_search_docs_tsv_idx").using("gin", table.tsv),
    ...wsPolicies(),
  ],
);

export const workspaceSearchDocumentPreviewPassages = p.pgTable(
  "workspace_search_document_preview_passages",
  {
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaceSearchDocuments.workspaceId, {
        onDelete: "cascade",
      }),
    organizationId: safeOrganizationId("organization_id").notNull(),
    generation: p.uuid().notNull(),
    ordinal: p.integer().notNull(),
    content: p.text().notNull(),
    tsv: tsvector().notNull(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.workspaceId, table.generation, table.ordinal],
      name: "workspace_search_document_preview_passages_pk",
    }),
    p
      .index("workspace_preview_passages_scope_idx")
      .on(
        table.organizationId,
        table.workspaceId,
        table.generation,
        table.ordinal,
      ),
    p.index("workspace_preview_passages_tsv_idx").using("gin", table.tsv),
    ...wsOrganizationReadOnlyPolicies(
      "workspace_search_document_preview_passages",
    ),
  ],
);

// One row per entity with extracted plaintext encrypted for search and
// downstream retrieval. Tenancy is denormalized through organizationId and
// workspaceId so queries can stay tenant-scoped without joining through the
// entity graph first. Deletes cascade from the owning entity.
export const extractedContent = p.pgTable(
  "extracted_content",
  {
    entityId: safeUuid<"entity">("entity_id").primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    /** Immutable source identity; null only for pre-provenance rows. */
    sourceEntityVersionId: safeUuid<"entityVersion">(
      "source_entity_version_id",
    ).references(() => entityVersions.id, { onDelete: "set null" }),
    sourceFieldId: safeUuid<"field">("source_field_id").references(
      () => fields.id,
      { onDelete: "set null" },
    ),
    sourceFileId: p.uuid("source_file_id"),
    sourceSha256Hex: p.varchar("source_sha256_hex", { length: 64 }),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    charCount: p.integer("char_count").notNull(),
    language: p.varchar("language", { length: 10 }),
    extractedAt: timestamptz("extracted_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("extracted_content_org_id_idx").on(table.organizationId),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p.index("extracted_content_workspace_id_idx").on(table.workspaceId),
    p
      .index("extracted_content_source_entity_version_id_idx")
      .on(table.sourceEntityVersionId),
    p.index("extracted_content_source_field_id_idx").on(table.sourceFieldId),
    p.check(
      "extracted_content_source_sha256_hex_check",
      sql`${table.sourceSha256Hex} IS NULL OR ${table.sourceSha256Hex} ~ '^[0-9a-f]{64}$'`,
    ),
    ...wsPolicies(),
  ],
);
