import { sql } from "drizzle-orm";

import { CONTACT_TYPES } from "@stll/api-contract";
import type { TemplatePackAuthor } from "@stll/template-packs/schema";

import type { AiFieldError } from "@/api/lib/docx/resolve-ai-fields";

import {
  ENTITY_KINDS,
  SEARCH_PROJECTION_KINDS,
  TEMPLATE_DELETION_CLEANUP_STATUSES,
  bytea,
  jsonb,
  organizationCheck,
  orgPolicies,
  orgReadOnlyPolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  stella,
  tsvector,
  user,
  wsOrganizationPolicies,
  wsOrganizationReadOnlyPolicies,
  timestamptz,
} from "./common";
import type {
  AnyPgColumn,
  SafeId,
  SearchProjectionKind,
  TemplateDeletionCleanupStatus,
  TemplateManifest,
} from "./common";
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

export const TEMPLATE_ORIGIN_TYPES = ["authored", "bundled-pack"] as const;
export type TemplateOriginType = (typeof TEMPLATE_ORIGIN_TYPES)[number];

const TEMPLATE_ORIGIN_TYPE_SQL_VALUES = TEMPLATE_ORIGIN_TYPES.map((value) =>
  sql.raw(`'${value}'`),
);

/**
 * Where a template's first version came from. `authored` covers every
 * in-app path (upload, studio, AI preparation, report clone); `bundled-pack`
 * records the pack template it was installed from, with the content hash of
 * the bytes copied and the attribution the pack carried at that time.
 */
export type TemplateOrigin =
  | { type: "authored" }
  | {
      type: "bundled-pack";
      packId: string;
      packVersion: string;
      slug: string;
      contentHash: string;
      license: string;
      authors: TemplatePackAuthor[];
    };

export const AUTHORED_TEMPLATE_ORIGIN = { type: "authored" } as const;

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
    /** Discriminator of `origin`, duplicated as a column so it can be
     *  filtered and constrained without JSONB operators. */
    originType: p
      .text("origin_type", { enum: TEMPLATE_ORIGIN_TYPES })
      .notNull()
      .default("authored"),
    origin: jsonb()
      .$type<TemplateOrigin>()
      .notNull()
      .default(AUTHORED_TEMPLATE_ORIGIN),
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
    p.check(
      "templates_origin_type_values_check",
      sql`${table.originType} IN (${sql.join(TEMPLATE_ORIGIN_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    // The column and the JSON discriminator cannot disagree, and a pack
    // origin carries every field `TemplateOrigin` declares, so no write can
    // persist provenance that a typed reader assumes is complete. COALESCE
    // is load-bearing: a missing key makes its comparison NULL, and a CHECK
    // admits NULL, so without it an absent member would pass.
    p.check(
      "templates_origin_shape_check",
      sql`COALESCE((${table.originType} = 'authored' AND ${table.origin} = '{"type":"authored"}'::jsonb) OR (${table.originType} = 'bundled-pack' AND ${table.origin}->>'type' = 'bundled-pack' AND ${table.origin}->>'packId' IS NOT NULL AND ${table.origin}->>'packVersion' IS NOT NULL AND ${table.origin}->>'slug' IS NOT NULL AND ${table.origin}->>'contentHash' IS NOT NULL AND ${table.origin}->>'license' IS NOT NULL AND jsonb_typeof(${table.origin}->'authors') = 'array'), false)`,
    ),
    // One copy of a pack template per organization: a repeat install is a
    // no-op at the database, not only at the handler.
    p
      .uniqueIndex("templates_org_pack_template_uidx")
      .on(
        table.organizationId,
        sql`(${table.origin}->>'packId')`,
        sql`(${table.origin}->>'slug')`,
      )
      .where(sql`${table.originType} = 'bundled-pack'`),
    ...orgPolicies(),
  ],
);

export type TemplatePersistenceResult =
  | {
      action: "create_document";
      entityId: SafeId<"entity">;
      entityVersionId: SafeId<"entityVersion">;
      fileName: string;
      unmatchedPlaceholders: string[];
      unusedValues: string[];
      /** Optional only because receipts persisted before AI diagnostics were
       * recorded do not carry this property. New partial receipts include it. */
      aiFieldErrors?: TemplatePersistenceAiFieldError[] | undefined;
    }
  | {
      action: "create_version";
      entityId: SafeId<"entity">;
      entityVersionId: SafeId<"entityVersion">;
      fileName: string;
      unmatchedPlaceholders: string[];
      unusedValues: string[];
      /** See the persisted-receipt compatibility boundary above. */
      aiFieldErrors?: TemplatePersistenceAiFieldError[] | undefined;
      versionNumber: number;
    };

type TemplatePersistenceAiFieldError = {
  field: AiFieldError["valuePath"];
} & Pick<AiFieldError, "reason" | "message">;

export const TEMPLATE_PERSISTENCE_REQUEST_STATUS = {
  COMPLETED: "completed",
  PENDING: "pending",
} as const;

export type TemplatePersistenceRequestStatus =
  (typeof TEMPLATE_PERSISTENCE_REQUEST_STATUS)[keyof typeof TEMPLATE_PERSISTENCE_REQUEST_STATUS];

/** Durable receipt that makes save_filled_template retries idempotent. */
export const templatePersistenceRequests = p.pgTable(
  "template_persistence_requests",
  {
    id: pUuid<"templatePersistenceRequest">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    idempotencyKey: p.varchar("idempotency_key", { length: 128 }).notNull(),
    requestFingerprint: p
      .varchar("request_fingerprint", { length: 64 })
      .notNull(),
    status: p
      .varchar({ length: 16 })
      .$type<TemplatePersistenceRequestStatus>()
      .notNull()
      .default(TEMPLATE_PERSISTENCE_REQUEST_STATUS.PENDING),
    claimToken: p.uuid("claim_token").notNull(),
    claimedAt: timestamptz("claimed_at").notNull().defaultNow(),
    result: jsonb().$type<TemplatePersistenceResult>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    p
      .uniqueIndex("template_persistence_requests_org_user_key_uidx")
      .on(table.organizationId, table.userId, table.idempotencyKey),
    p
      .index("template_persistence_requests_workspace_created_idx")
      .on(table.workspaceId, table.createdAt),
    p.check(
      "template_persistence_requests_key_nonempty_check",
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    p.check(
      "template_persistence_requests_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "template_persistence_requests_state_check",
      sql`(${table.status} = ${TEMPLATE_PERSISTENCE_REQUEST_STATUS.PENDING} AND ${table.result} IS NULL AND ${table.completedAt} IS NULL) OR (${table.status} = ${TEMPLATE_PERSISTENCE_REQUEST_STATUS.COMPLETED} AND ${table.result} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "template_persistence_requests_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("template_persistence_requests"),
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

const TEMPLATE_DELETION_CLEANUP_STATUS_SQL_VALUES =
  TEMPLATE_DELETION_CLEANUP_STATUSES.map((status) => sql.raw(`'${status}'`));

/**
 * Durable object cleanup recorded in the same transaction that deletes a
 * template. It has no template foreign key because it must survive that
 * deletion until storage erasure succeeds.
 */
export const templateDeletionCleanupRequests = p.pgTable(
  "template_deletion_cleanup_requests",
  {
    id: pUuid<"templateDeletionCleanupRequest">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    s3Keys: p.text("s3_keys").array().notNull(),
    status: p
      .text("status", { enum: TEMPLATE_DELETION_CLEANUP_STATUSES })
      .$type<TemplateDeletionCleanupStatus>()
      .notNull()
      .default("pending"),
    attemptCount: p.integer("attempt_count").notNull().default(0),
    errorMessage: p.text("error_message"),
    nextAttemptAt: timestamptz("next_attempt_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    p
      .index("template_deletion_cleanup_pending_schedule_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    p
      .index("template_deletion_cleanup_failed_schedule_idx")
      .on(table.nextAttemptAt, table.id)
      .where(sql`${table.status} = 'failed'`),
    p
      .index("template_deletion_cleanup_processing_lease_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.status} = 'processing'`),
    p.check(
      "template_deletion_cleanup_status_values_check",
      sql`${table.status} IN (${sql.join(TEMPLATE_DELETION_CLEANUP_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "template_deletion_cleanup_attempt_count_nonnegative_check",
      sql`${table.attemptCount} >= 0`,
    ),
    // The deleting request may create the outbox row, but only the root
    // scheduler reads keys or transitions cleanup state.
    p.pgPolicy("template_deletion_cleanup_insert", {
      for: "insert",
      to: stella,
      withCheck: organizationCheck,
    }),
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
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "search_documents_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("search_documents"),
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
    // Named explicitly: drizzle's generated name exceeds PostgreSQL's 63-byte
    // identifier limit and would be silently truncated in the catalog.
    p
      .foreignKey({
        name: "search_document_preview_passages_organization_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "search_document_preview_passages_workspace_organization_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
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
        enum: CONTACT_TYPES,
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
    p
      .foreignKey({
        name: "contact_search_document_preview_passages_organization_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
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
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "workspace_search_documents_workspace_organization_fk",
      })
      .onDelete("cascade"),
    ...wsOrganizationPolicies("workspace_search_documents"),
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
    p
      .foreignKey({
        name: "workspace_search_document_preview_passages_organization_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    // `organization` is abbreviated to `org` here and nowhere else in this
    // family: the table's own name leaves only 21 bytes before PostgreSQL's
    // 63-byte identifier limit truncates the constraint.
    p
      .foreignKey({
        name: "workspace_search_document_preview_passages_workspace_org_fk",
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    ...wsOrganizationReadOnlyPolicies(
      "workspace_search_document_preview_passages",
    ),
  ],
);

const SEARCH_PROJECTION_KIND_SQL_VALUES = SEARCH_PROJECTION_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);

/**
 * The durable record that a search projection is behind its source.
 *
 * Every mutation that changes searchable text writes its source here inside
 * the same transaction, so the dirty mark commits or rolls back with the
 * mutation itself. The projection write that follows the commit is only an
 * acceleration; this row is the guarantee, and it survives the restart,
 * crash, or deploy that loses the write.
 *
 * One row per source: a burst of edits collapses onto the same key and is
 * repaired once. `revision` is rewritten by every enqueue, and the drain
 * removes or reschedules only the exact revision it repaired, so an edit that
 * lands while a repair is in flight is not deleted as already handled.
 * `attempts` and `next_attempt_at` keep a source the repair cannot fix from
 * occupying the head of every batch.
 */
export const searchProjectionRepairQueue = p.pgTable(
  "search_projection_repair_queue",
  {
    kind: p
      .text("kind", { enum: SEARCH_PROJECTION_KINDS })
      .$type<SearchProjectionKind>()
      .notNull(),
    // Deliberately without a foreign key: a mark whose source is gone is not
    // an error to prevent but work to discard, and the drain discards it on
    // its next pass.
    sourceId: p.uuid("source_id").notNull(),
    // Unlike the storage-cleanup outboxes in schema/entities.ts, this queue
    // holds no object keys: the drain only rewrites and deletes database rows.
    // A repair mark for a tenant that no longer exists is genuinely moot, so
    // cascading it from organization discards nothing that anything could act
    // on later. See the comments on entity_deletion_cleanup_requests and
    // buffer_object_cleanup_intents for why those two cannot do the same.
    organizationId: safeOrganizationId("organization_id").notNull(),
    revision: p.uuid("revision").notNull(),
    enqueuedAt: timestamptz("enqueued_at").notNull().defaultNow(),
    attempts: p.integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.kind, table.sourceId],
      name: "search_projection_repair_queue_pk",
    }),
    p
      .index("search_projection_repair_due_idx")
      .on(table.nextAttemptAt, table.enqueuedAt),
    p.check(
      "search_projection_repair_kind_values_check",
      sql`${table.kind} IN (${sql.join(SEARCH_PROJECTION_KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "search_projection_repair_attempts_nonnegative_check",
      sql`${table.attempts} >= 0`,
    ),
    p
      .foreignKey({
        name: "search_projection_repair_queue_organization_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    ...orgPolicies(),
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
    /** OCR-only derivative identity; null for native extraction rows. */
    ocrRunId: safeUuid<"documentProcessingRun">("ocr_run_id"),
    ocrProcessorVersion: p.integer("ocr_processor_version"),
    /** Encrypted versioned page geometry used by viewers and regeneration. */
    ocrPayloadCiphertext: bytea("ocr_payload_ciphertext"),
    ocrPayloadIv: bytea("ocr_payload_iv"),
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
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "extracted_content_workspace_organization_fk",
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
    p.check(
      "extracted_content_ocr_payload_complete_check",
      sql`(
        ${table.ocrRunId} IS NULL
        AND ${table.ocrProcessorVersion} IS NULL
        AND ${table.ocrPayloadCiphertext} IS NULL
        AND ${table.ocrPayloadIv} IS NULL
      ) OR (
        ${table.ocrRunId} IS NOT NULL
        AND ${table.ocrProcessorVersion} > 0
        AND ${table.ocrPayloadCiphertext} IS NOT NULL
        AND ${table.ocrPayloadIv} IS NOT NULL
      )`,
    ),
    ...wsOrganizationPolicies("extracted_content"),
  ],
);
