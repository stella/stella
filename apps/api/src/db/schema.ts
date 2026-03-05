import { defineRelations, isNotNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import * as p from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";

import { organization, user } from "@/api/db/auth-schema";
import type {
  BankAccount,
  BillingAddress,
  BoundingBoxes,
  ContactAddress,
  ContactEmail,
  ContactPhone,
  EntityKind,
  FieldContent,
  PropertyCondition,
  PropertyContent,
  PropertyTool,
  ViewConfig,
} from "@/api/db/schema-validators";
import type { ClauseBody } from "@/api/handlers/clauses/types";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import type { SafeId } from "@/api/lib/branded-types";

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea",
  fromDriver: (value) => {
    if (Buffer.isBuffer(value)) {
      return value;
    }
    if (typeof value === "string") {
      const hex = value.startsWith("\\x") ? value.slice(2) : value;
      return Buffer.from(hex, "hex");
    }
    throw new Error(`Unexpected bytea driver value: ${typeof value}`);
  },
});

const safeWorkspaceId = (name: string) =>
  p.varchar(name, { length: 21 }).$type<SafeId<"workspace">>();

const safeOrganizationId = (name: string) =>
  p.varchar(name, { length: 128 }).$type<SafeId<"organization">>();

const pNanoid = p.varchar({ length: 21 }).$defaultFn(() => nanoid());

export const propertyStatusEnum = p.pgEnum("property_status", [
  "uninitialized",
  "stale",
  "fresh",
]);
export type PropertyStatus = (typeof propertyStatusEnum)["enumValues"][number];

export const entityKindEnum = p.pgEnum("entity_kind", [
  "document",
  "folder",
  "task",
  "message",
]);

export const viewLayoutEnum = p.pgEnum("view_layout", [
  "overview",
  "table",
  "filesystem",
  // "gallery" kept in DB enum (PostgreSQL cannot drop
  // enum values); the layout is removed from validators
  // and UI
  "gallery",
  "kanban",
]);

export const timeEntryStatusEnum = p.pgEnum("time_entry_status", [
  "draft",
  "approved",
  "billed",
  "written_off",
]);
export type TimeEntryStatus = (typeof timeEntryStatusEnum.enumValues)[number];
/** Named constants for time entry and expense statuses
 *  (both tables share timeEntryStatusEnum). */
export const BILLING_STATUS = {
  DRAFT: "draft",
  APPROVED: "approved",
  BILLED: "billed",
  WRITTEN_OFF: "written_off",
} as const satisfies Record<string, TimeEntryStatus>;

export const expenseCategoryEnum = p.pgEnum("expense_category", [
  "filing_fee",
  "expert_witness",
  "travel",
  "printing",
  "courier",
  "other",
]);
export type ExpenseCategory = (typeof expenseCategoryEnum.enumValues)[number];

export const timeEntrySourceEnum = p.pgEnum("time_entry_source", [
  "manual",
  "timer",
]);
export type TimeEntrySource = (typeof timeEntrySourceEnum.enumValues)[number];
export const TIME_ENTRY_SOURCE = {
  MANUAL: "manual",
  TIMER: "timer",
} as const satisfies Record<string, TimeEntrySource>;

// -- Contacts --

export const contacts = p.pgTable(
  "contacts",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    type: p.text({ enum: ["person", "organization"] }).notNull(),

    // Person fields (null for organizations)
    prefix: p.varchar({ length: 32 }),
    firstName: p.varchar("first_name", { length: 256 }),
    middleName: p.varchar("middle_name", { length: 256 }),
    lastName: p.varchar("last_name", { length: 256 }),
    suffix: p.varchar({ length: 32 }),

    // Organization fields (null for persons)
    organizationName: p.varchar("organization_name", {
      length: 512,
    }),

    // Shared fields
    displayName: p.varchar("display_name", { length: 512 }).notNull(),
    notes: p.text(),
    emails: p.jsonb().$type<ContactEmail[]>(),
    phones: p.jsonb().$type<ContactPhone[]>(),
    addresses: p.jsonb().$type<ContactAddress[]>(),
    tags: p.text().array(),
    metadata: p.jsonb().$type<Record<string, unknown>>(),
    color: p.varchar({ length: 32 }),

    // Billing fields
    registrationNumber: p.varchar("registration_number", {
      length: 64,
    }),
    taxId: p.varchar("tax_id", { length: 64 }),
    bankAccounts: p.jsonb("bank_accounts").$type<BankAccount[]>(),
    billingAddress: p.jsonb("billing_address").$type<BillingAddress>(),
    defaultHourlyRate: p.integer("default_hourly_rate"),
    currency: p.varchar({ length: 3 }),
    paymentTermDays: p.integer("payment_term_days"),

    // Attorney responsibility
    originatingAttorneyId: p
      .text("originating_attorney_id")
      .references(() => user.id, { onDelete: "set null" }),
    responsibleAttorneyId: p
      .text("responsible_attorney_id")
      .references(() => user.id, { onDelete: "set null" }),

    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.index("contacts_organization_id_idx").on(table.organizationId),
    p.index("contacts_org_type_idx").on(table.organizationId, table.type),
    p
      .index("contacts_org_display_name_idx")
      .on(table.organizationId, table.displayName),
    p
      .index("contacts_org_first_name_idx")
      .on(table.organizationId, table.firstName),
    p
      .index("contacts_org_last_name_idx")
      .on(table.organizationId, table.lastName),
    p
      .index("contacts_org_org_name_idx")
      .on(table.organizationId, table.organizationName),
  ],
);

export type ContactType = (typeof contacts.type)["enumValues"][number];

export const contactRelationships = p.pgTable(
  "contact_relationships",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    personId: p
      .varchar("person_id", { length: 21 })
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    relatedContactId: p
      .varchar("related_contact_id", { length: 21 })
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    relationshipType: p
      .text("relationship_type", {
        enum: ["employee", "partner", "director", "counsel", "other"],
      })
      .notNull(),
    title: p.varchar({ length: 256 }),
    isPrimary: p.boolean("is_primary").notNull().default(false),
    startDate: p.date("start_date"),
    endDate: p.date("end_date"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("contact_relationships_person_id_idx").on(table.personId),
    p
      .index("contact_relationships_related_contact_id_idx")
      .on(table.relatedContactId),
    p.index("contact_relationships_org_id_idx").on(table.organizationId),
    p.check(
      "contact_relationships_no_self_reference_check",
      sql`${table.personId} != ${table.relatedContactId}`,
    ),
  ],
);

// -- Files --

export const files = p.pgTable(
  "files",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceFileId: p.varchar("source_file_id", { length: 21 }),
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    mimeType: p.varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: p.integer("size_bytes").notNull(),
    encrypted: p.boolean("encrypted").notNull().default(false),
    sha256Hex: p.varchar("sha256_hex", { length: 64 }).notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("files_workspace_id_sha256_idx")
      .on(table.workspaceId, table.sha256Hex),
  ],
);

// -- Workspaces --

export const workspaces = p.pgTable(
  "workspaces",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    reference: p.varchar({ length: 64 }),
    clientId: p
      .varchar("client_id", { length: 21 })
      .references(() => contacts.id, { onDelete: "set null" }),
    billingReference: p.varchar("billing_reference", {
      length: 128,
    }),
    color: p.varchar({ length: 32 }),
    status: p
      .text({ enum: ["active", "deleting"] })
      .notNull()
      .default("active"),
    lastActivityAt: p.timestamp("last_activity_at").notNull().defaultNow(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("workspaces_organization_id_idx").on(table.organizationId),
    p
      .uniqueIndex("workspaces_org_reference_uidx")
      .on(table.organizationId, table.reference),
    p
      .index("workspaces_client_id_idx")
      .on(table.clientId)
      .where(isNotNull(table.clientId)),
    p
      .index("workspaces_org_last_activity_idx")
      .on(table.organizationId, table.lastActivityAt),
  ],
);

export const workspaceContacts = p.pgTable(
  "workspace_contacts",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: p
      .varchar("contact_id", { length: 21 })
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    role: p
      .text({
        enum: [
          "opposing_party",
          "opposing_counsel",
          "co_counsel",
          "witness",
          "expert_witness",
          "third_party",
          "judge",
          "mediator",
          "other",
        ],
      })
      .notNull(),
    isPrimary: p.boolean("is_primary").notNull().default(false),
    notes: p.text(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("workspace_contacts_workspace_id_idx").on(table.workspaceId),
    p.index("workspace_contacts_contact_id_idx").on(table.contactId),
    p
      .index("workspace_contacts_org_workspace_idx")
      .on(table.organizationId, table.workspaceId),
    p
      .uniqueIndex("workspace_contacts_ws_contact_role_uidx")
      .on(table.workspaceId, table.contactId, table.role),
  ],
);

// -- Properties --

export const properties = p.pgTable(
  "properties",
  {
    id: pNanoid.primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    status: propertyStatusEnum().notNull().default("uninitialized"),
    content: p.jsonb().$type<PropertyContent>().notNull(),
    tool: p.jsonb().$type<PropertyTool>().notNull(),
    system: p.boolean().notNull().default(false),
    kinds: p.varchar({ length: 64 }).array().$type<EntityKind>(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [p.index("properties_workspace_id_idx").on(table.workspaceId)],
);

export const propertyDependencies = p.pgTable(
  "property_dependencies",
  {
    id: pNanoid.primaryKey(),
    propertyId: p
      .varchar("property_id", { length: 21 })
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    dependsOnPropertyId: p
      .varchar("depends_on_property_id", { length: 21 })
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    condition: p.jsonb().$type<PropertyCondition>(),
  },
  (table) => [
    p
      .uniqueIndex(
        "property_dependencies_property_id_depends_on_property_id_key",
      )
      .on(table.propertyId, table.dependsOnPropertyId),
    p.index("property_dependencies_property_id_idx").on(table.propertyId),
    p
      .index("property_dependencies_depends_on_property_id_idx")
      .on(table.dependsOnPropertyId),
    p.check(
      "property_dependencies_no_self_reference_check",
      sql`${table.propertyId} != ${table.dependsOnPropertyId}`,
    ),
  ],
);

// -- Entities --

export const entities = p.pgTable(
  "entities",
  {
    id: pNanoid.primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: entityKindEnum().notNull().default("document"),
    parentId: p
      .varchar("parent_id", { length: 21 })
      .references((): AnyPgColumn => entities.id, {
        onDelete: "set null",
      }),
    name: p.text("name"),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    currentVersionId: p
      .varchar("current_version_id", { length: 21 })
      .references((): AnyPgColumn => entityVersions.id, {
        onDelete: "restrict",
      }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").defaultNow(),
  },
  (table) => [
    p.index("entities_workspace_id_idx").on(table.workspaceId),
    p
      .index("entities_parent_id_idx")
      .on(table.parentId)
      .where(isNotNull(table.parentId)),
    p.index("entities_workspace_name_idx").on(table.workspaceId, table.name),
  ],
);

export const entityVersions = p.pgTable(
  "entity_versions",
  {
    id: pNanoid.primaryKey(),
    entityId: p
      .varchar("entity_id", { length: 21 })
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [p.index("entity_versions_entity_id_idx").on(table.entityId)],
);

export const fields = p.pgTable(
  "fields",
  {
    id: pNanoid.primaryKey(),
    propertyId: p
      .varchar("property_id", { length: 21 })
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    entityVersionId: p
      .varchar("entity_version_id", { length: 21 })
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    fileId: p
      .varchar("file_id", { length: 21 })
      .references(() => files.id, { onDelete: "restrict" }),
    content: p.jsonb().$type<FieldContent>().notNull(),
  },
  (table) => [
    p
      .uniqueIndex("fields_property_id_entity_version_id_key")
      .on(table.propertyId, table.entityVersionId),
  ],
);

export const justifications = p.pgTable(
  "justifications",
  {
    id: pNanoid.primaryKey(),
    fieldId: p
      .varchar("field_id", { length: 21 })
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    htmlVersion: p.numeric("html_version", { mode: "number" }).notNull(),
    htmlContent: p.text("html_content").notNull(),
    boundingBoxes: p.jsonb("bounding_boxes").$type<BoundingBoxes>(),
    fileFieldIds: p
      .varchar("file_field_ids", { length: 21 })
      .array()
      .notNull()
      .default([]),
  },
  (table) => [p.uniqueIndex("justifications_field_id_key").on(table.fieldId)],
);

export const templates = p.pgTable(
  "templates",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    categoryId: p
      .varchar("category_id", { length: 21 })
      .references((): AnyPgColumn => templateCategories.id, {
        onDelete: "set null",
      }),
    name: p.varchar({ length: 256 }).notNull(),
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    s3Key: p.varchar("s3_key", { length: 512 }).notNull(),
    sizeBytes: p.integer("size_bytes").notNull(),
    manifest: p.jsonb().$type<TemplateManifest>(),
    fieldCount: p.integer("field_count").notNull().default(0),
    currentVersion: p.integer("current_version").notNull().default(1),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
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
  ],
);

export const templateVersions = p.pgTable(
  "template_versions",
  {
    id: pNanoid.primaryKey(),
    templateId: p
      .varchar("template_id", { length: 21 })
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    version: p.integer().notNull(),
    s3Key: p.varchar("s3_key", { length: 512 }).notNull(),
    manifest: p.jsonb().$type<TemplateManifest>(),
    fieldCount: p.integer("field_count").notNull().default(0),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("template_versions_template_version_uidx")
      .on(table.templateId, table.version),
    p.index("template_versions_template_id_idx").on(table.templateId),
  ],
);

// -- Search --

export const searchDocuments = p.pgTable(
  "search_documents",
  {
    entityId: p
      .varchar("entity_id", { length: 21 })
      .primaryKey()
      .references(() => entities.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: entityKindEnum().notNull(),
    title: p.text().notNull().default(""),
    searchableText: p.text("searchable_text").notNull().default(""),
    language: p.varchar("language", { length: 10 }),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("search_documents_org_id_idx").on(table.organizationId),
    p
      .index("search_documents_org_workspace_idx")
      .on(table.organizationId, table.workspaceId),
  ],
);

export const extractedContent = p.pgTable(
  "extracted_content",
  {
    entityId: p
      .varchar("entity_id", { length: 21 })
      .primaryKey()
      .references(() => entities.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, {
        onDelete: "cascade",
      }),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    charCount: p.integer("char_count").notNull(),
    language: p.varchar("language", { length: 10 }),
    extractedAt: p.timestamp("extracted_at").notNull().defaultNow(),
  },
  (table) => [p.index("extracted_content_org_id_idx").on(table.organizationId)],
);

// -- Views --

export const views = p.pgTable(
  "views",
  {
    id: pNanoid.primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    name: p.varchar({ length: 256 }).notNull(),
    layout: viewLayoutEnum().notNull(),
    config: p.jsonb().$type<ViewConfig>().notNull(),
    position: p.integer().notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [p.index("views_workspace_id_idx").on(table.workspaceId)],
);

export const timeEntries = p.pgTable(
  "time_entries",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .references(() => user.id, { onDelete: "set null" }),
    matterId: p
      .varchar("matter_id", { length: 21 })
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    dateWorked: p.date("date_worked").notNull(),
    timezoneId: p.text("timezone_id").notNull(),
    durationMinutes: p.integer("duration_minutes").notNull(),
    billedMinutes: p.integer("billed_minutes").notNull(),
    rateAtEntry: p.integer("rate_at_entry").notNull(),
    currency: p.varchar({ length: 3 }).notNull(),
    narrative: p.text().notNull(),
    invoiceNarrative: p.text("invoice_narrative"),
    billable: p.boolean().notNull().default(true),
    noCharge: p.boolean("no_charge").notNull().default(false),
    status: timeEntryStatusEnum().notNull().default("draft"),
    source: timeEntrySourceEnum().notNull().default("manual"),
    taskCode: p.varchar("task_code", { length: 20 }),
    activityCode: p.varchar("activity_code", { length: 20 }),
    invoiceId: p
      .varchar("invoice_id", { length: 21 })
      .references(() => invoices.id, { onDelete: "set null" }),
    splitGroupId: p.varchar("split_group_id", { length: 21 }),
    timerStartedAt: p.timestamp("timer_started_at", {
      withTimezone: true,
    }),
    timerStoppedAt: p.timestamp("timer_stopped_at", {
      withTimezone: true,
    }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").defaultNow(),
  },
  (table) => [
    p
      .index("time_entries_ws_user_date_idx")
      .on(table.workspaceId, table.userId, table.dateWorked),
    p
      .index("time_entries_ws_matter_status_idx")
      .on(table.workspaceId, table.matterId, table.status),
    p.index("time_entries_ws_status_idx").on(table.workspaceId, table.status),
    p.index("time_entries_invoice_idx").on(table.invoiceId),
    p.check(
      "time_entries_duration_or_timer_check",
      sql`${table.durationMinutes} > 0 OR ${table.timerStartedAt} IS NOT NULL`,
    ),
    p.check(
      "time_entries_billed_minutes_check",
      sql`${table.billedMinutes} >= 0`,
    ),
  ],
);

export const billingCodeTypeEnum = p.pgEnum("billing_code_type", [
  "task",
  "activity",
]);

export const billingCodes = p.pgTable(
  "billing_codes",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: billingCodeTypeEnum().notNull(),
    code: p.varchar({ length: 20 }).notNull(),
    label: p.varchar({ length: 256 }).notNull(),
    active: p.boolean().notNull().default(true),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("billing_codes_ws_type_active_idx")
      .on(table.workspaceId, table.type, table.active),
    p
      .uniqueIndex("billing_codes_ws_type_code_uidx")
      .on(table.workspaceId, table.type, table.code),
  ],
);

export const rateTables = p.pgTable(
  "rate_tables",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    currency: p.varchar({ length: 3 }).notNull(),
    isDefault: p.boolean("is_default").notNull().default(false),
    clientId: p.varchar("client_id", { length: 21 }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("rate_tables_ws_default_idx")
      .on(table.workspaceId, table.isDefault),
    p.index("rate_tables_ws_client_idx").on(table.workspaceId, table.clientId),
  ],
);

export const rateEntries = p.pgTable(
  "rate_entries",
  {
    id: pNanoid.primaryKey(),
    rateTableId: p
      .varchar("rate_table_id", { length: 21 })
      .notNull()
      .references(() => rateTables.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .references(() => user.id, { onDelete: "cascade" }),
    hourlyRate: p.integer("hourly_rate").notNull(),
    effectiveFrom: p.date("effective_from").notNull(),
    effectiveTo: p.date("effective_to"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("rate_entries_table_user_from_idx")
      .on(table.rateTableId, table.userId, table.effectiveFrom),
  ],
);

export const expenses = p.pgTable(
  "expenses",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .references(() => user.id, { onDelete: "set null" }),
    matterId: p
      .varchar("matter_id", { length: 21 })
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    dateIncurred: p.date("date_incurred").notNull(),
    amount: p.integer().notNull(),
    currency: p.varchar({ length: 3 }).notNull(),
    category: expenseCategoryEnum().notNull(),
    description: p.text().notNull(),
    invoiceDescription: p.text("invoice_description"),
    billable: p.boolean().notNull().default(true),
    markup: p.integer().notNull().default(0),
    status: timeEntryStatusEnum().notNull().default("draft"),
    invoiceId: p
      .varchar("invoice_id", { length: 21 })
      .references(() => invoices.id, { onDelete: "set null" }),
    receiptFileId: p.varchar("receipt_file_id", { length: 21 }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").defaultNow(),
  },
  (table) => [
    p
      .index("expenses_ws_matter_status_idx")
      .on(table.workspaceId, table.matterId, table.status),
    p
      .index("expenses_ws_user_date_idx")
      .on(table.workspaceId, table.userId, table.dateIncurred),
    p.index("expenses_invoice_idx").on(table.invoiceId),
    p.check("expenses_amount_positive_check", sql`${table.amount} > 0`),
  ],
);

export const invoiceStatusEnum = p.pgEnum("invoice_status", [
  "draft",
  "finalized",
  "sent",
  "paid",
  "void",
]);
export type InvoiceStatus = (typeof invoiceStatusEnum)["enumValues"][number];

export const INVOICE_STATUS = {
  DRAFT: "draft",
  FINALIZED: "finalized",
  SENT: "sent",
  PAID: "paid",
  VOID: "void",
} as const satisfies Record<string, InvoiceStatus>;

export const invoices = p.pgTable(
  "invoices",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    invoiceNumber: p.varchar("invoice_number", { length: 64 }).notNull(),
    reference: p.varchar({ length: 256 }),
    status: invoiceStatusEnum().notNull().default("draft"),
    invoiceDate: p.date("invoice_date").notNull(),
    dueDate: p.date("due_date"),
    currency: p.varchar({ length: 3 }).notNull(),
    totalAmount: p.integer("total_amount").notNull().default(0),
    notes: p.text(),
    paidAt: p.timestamp("paid_at"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("invoices_ws_status_idx").on(table.workspaceId, table.status),
    p
      .uniqueIndex("invoices_ws_number_uidx")
      .on(table.workspaceId, table.invoiceNumber),
  ],
);

export const matterCounters = p.pgTable(
  "matter_counters",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    scopeKey: p.varchar("scope_key", { length: 128 }).notNull(),
    lastValue: p.integer("last_value").notNull().default(0),
  },
  (table) => [
    p
      .uniqueIndex("matter_counters_org_scope_uidx")
      .on(table.organizationId, table.scopeKey),
  ],
);

export const organizationSettings = p.pgTable("organization_settings", {
  id: pNanoid.primaryKey(),
  organizationId: safeOrganizationId("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id, { onDelete: "cascade" }),
  matterNumberPattern: p
    .varchar("matter_number_pattern", { length: 128 })
    .notNull()
    .default("{SEQ}"),
  matterNumberPadding: p.integer("matter_number_padding").notNull().default(3),
  updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
});

export const clauseCategories = p.pgTable(
  "clause_categories",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    parentId: p
      .varchar("parent_id", { length: 21 })
      .references((): AnyPgColumn => clauseCategories.id, {
        onDelete: "set null",
      }),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("clause_categories_organization_id_idx").on(table.organizationId),
    p
      .index("clause_categories_org_parent_idx")
      .on(table.organizationId, table.parentId),
  ],
);

export const clauses = p.pgTable(
  "clauses",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    categoryId: p
      .varchar("category_id", { length: 21 })
      .references(() => clauseCategories.id, {
        onDelete: "set null",
      }),
    title: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    usageNotes: p.text("usage_notes"),
    language: p.varchar({ length: 10 }),
    body: p.jsonb().$type<ClauseBody>().notNull(),
    metadata: p.jsonb().$type<Record<string, unknown>>(),
    searchVector: tsvector("search_vector"),
    currentVersion: p.integer("current_version").notNull().default(1),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("clauses_organization_id_idx").on(table.organizationId),
    p
      .index("clauses_org_category_idx")
      .on(table.organizationId, table.categoryId),
    p
      .index("clauses_org_created_at_idx")
      .on(table.organizationId, table.createdAt),
    p.index("clauses_search_vector_gin_idx").using("gin", table.searchVector),
  ],
);

export const clauseVariants = p.pgTable(
  "clause_variants",
  {
    id: pNanoid.primaryKey(),
    clauseId: p
      .varchar("clause_id", { length: 21 })
      .notNull()
      .references(() => clauses.id, { onDelete: "cascade" }),
    label: p.varchar({ length: 256 }).notNull(),
    body: p.jsonb().$type<ClauseBody>().notNull(),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [p.index("clause_variants_clause_id_idx").on(table.clauseId)],
);

export const clauseVersions = p.pgTable(
  "clause_versions",
  {
    id: pNanoid.primaryKey(),
    clauseId: p
      .varchar("clause_id", { length: 21 })
      .notNull()
      .references(() => clauses.id, { onDelete: "cascade" }),
    version: p.integer().notNull(),
    body: p.jsonb().$type<ClauseBody>().notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("clause_versions_clause_version_uidx")
      .on(table.clauseId, table.version),
  ],
);

export const templateCategories = p.pgTable(
  "template_categories",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    parentId: p
      .varchar("parent_id", { length: 21 })
      .references((): AnyPgColumn => templateCategories.id, {
        onDelete: "set null",
      }),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("template_categories_organization_id_idx").on(table.organizationId),
    p
      .index("template_categories_org_parent_idx")
      .on(table.organizationId, table.parentId),
  ],
);

export const templateClauses = p.pgTable(
  "template_clauses",
  {
    id: pNanoid.primaryKey(),
    templateId: p
      .varchar("template_id", { length: 21 })
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    clauseId: p
      .varchar("clause_id", { length: 21 })
      .references(() => clauses.id, { onDelete: "set null" }),
    clauseVariantId: p
      .varchar("clause_variant_id", { length: 21 })
      .references(() => clauseVariants.id, {
        onDelete: "set null",
      }),
    clauseVersionId: p
      .varchar("clause_version_id", { length: 21 })
      .references(() => clauseVersions.id, {
        onDelete: "set null",
      }),
    slotName: p.varchar("slot_name", { length: 128 }),
    sortOrder: p.integer("sort_order").notNull().default(0),
    insertedAt: p.timestamp("inserted_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("template_clauses_template_id_idx").on(table.templateId),
    p.index("template_clauses_clause_id_idx").on(table.clauseId),
    p
      .uniqueIndex("template_clauses_template_slot_uidx")
      .on(table.templateId, table.slotName)
      .where(isNotNull(table.slotName)),
  ],
);

// -- Template Fills (analytics) --

export const templateFills = p.pgTable(
  "template_fills",
  {
    id: pNanoid.primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    templateId: p
      .varchar("template_id", { length: 21 })
      .references(() => templates.id, { onDelete: "set null" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    format: p.text().notNull(),
    status: p.text().notNull(),
    unmatchedCount: p.integer("unmatched_count").notNull().default(0),
    unusedCount: p.integer("unused_count").notNull().default(0),
    structureErrors: p
      .jsonb("structure_errors")
      .$type<
        { message: string; paragraphIndex: number; directive: string }[] | null
      >(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("template_fills_organization_id_idx").on(table.organizationId),
    p
      .index("template_fills_org_created_at_idx")
      .on(table.organizationId, table.createdAt),
    p
      .index("template_fills_org_template_idx")
      .on(table.organizationId, table.templateId),
  ],
);

// -- Relations --

export const relations = defineRelations(
  {
    user,
    contacts,
    contactRelationships,
    workspaces,
    workspaceContacts,
    properties,
    propertyDependencies,
    entities,
    entityVersions,
    fields,
    justifications,
    views,
    templates,
    templateVersions,
    timeEntries,
    billingCodes,
    rateTables,
    rateEntries,
    expenses,
    invoices,
    matterCounters,
    organizationSettings,
    clauseCategories,
    clauses,
    clauseVariants,
    clauseVersions,
    templateCategories,
    templateClauses,
    templateFills,
    searchDocuments,
    extractedContent,
  },
  (r) => ({
    contacts: {
      workspacesAsClient: r.many.workspaces({
        from: r.contacts.id,
        to: r.workspaces.clientId,
      }),
      workspaceContacts: r.many.workspaceContacts({
        from: r.contacts.id,
        to: r.workspaceContacts.contactId,
      }),
      relationshipsAsPerson: r.many.contactRelationships({
        from: r.contacts.id,
        to: r.contactRelationships.personId,
        alias: "contactRelPerson",
      }),
      relationshipsAsRelated: r.many.contactRelationships({
        from: r.contacts.id,
        to: r.contactRelationships.relatedContactId,
        alias: "contactRelRelated",
      }),
      originatingAttorney: r.one.user({
        from: r.contacts.originatingAttorneyId,
        to: r.user.id,
        alias: "contactOrigAttorney",
      }),
      responsibleAttorney: r.one.user({
        from: r.contacts.responsibleAttorneyId,
        to: r.user.id,
        alias: "contactRespAttorney",
      }),
    },
    contactRelationships: {
      person: r.one.contacts({
        from: r.contactRelationships.personId,
        to: r.contacts.id,
        alias: "contactRelPerson",
      }),
      relatedContact: r.one.contacts({
        from: r.contactRelationships.relatedContactId,
        to: r.contacts.id,
        alias: "contactRelRelated",
      }),
    },
    workspaces: {
      client: r.one.contacts({
        from: r.workspaces.clientId,
        to: r.contacts.id,
      }),
      properties: r.many.properties({
        from: r.workspaces.id,
        to: r.properties.workspaceId,
      }),
      entities: r.many.entities({
        from: r.workspaces.id,
        to: r.entities.workspaceId,
      }),
      views: r.many.views({
        from: r.workspaces.id,
        to: r.views.workspaceId,
      }),
      timeEntries: r.many.timeEntries({
        from: r.workspaces.id,
        to: r.timeEntries.workspaceId,
      }),
      billingCodes: r.many.billingCodes({
        from: r.workspaces.id,
        to: r.billingCodes.workspaceId,
      }),
      rateTables: r.many.rateTables({
        from: r.workspaces.id,
        to: r.rateTables.workspaceId,
      }),
      expenses: r.many.expenses({
        from: r.workspaces.id,
        to: r.expenses.workspaceId,
      }),
      workspaceContacts: r.many.workspaceContacts({
        from: r.workspaces.id,
        to: r.workspaceContacts.workspaceId,
      }),
    },
    workspaceContacts: {
      workspace: r.one.workspaces({
        from: r.workspaceContacts.workspaceId,
        to: r.workspaces.id,
      }),
      contact: r.one.contacts({
        from: r.workspaceContacts.contactId,
        to: r.contacts.id,
      }),
    },
    properties: {
      workspace: r.one.workspaces({
        from: r.properties.workspaceId,
        to: r.workspaces.id,
      }),
      dependencies: r.many.propertyDependencies({
        from: r.properties.id,
        to: r.propertyDependencies.propertyId,
      }),
      fields: r.many.fields({
        from: r.properties.id,
        to: r.fields.propertyId,
      }),
    },
    propertyDependencies: {
      property: r.one.properties({
        from: r.propertyDependencies.propertyId,
        to: r.properties.id,
      }),
      dependsOnProperty: r.one.properties({
        from: r.propertyDependencies.dependsOnPropertyId,
        to: r.properties.id,
      }),
    },
    entities: {
      workspace: r.one.workspaces({
        from: r.entities.workspaceId,
        to: r.workspaces.id,
      }),
      parent: r.one.entities({
        from: r.entities.parentId,
        to: r.entities.id,
        alias: "entityParent",
      }),
      children: r.many.entities({
        from: r.entities.id,
        to: r.entities.parentId,
        alias: "entityParent",
      }),
      versions: r.many.entityVersions({
        from: r.entities.id,
        to: r.entityVersions.entityId,
      }),
      currentVersion: r.one.entityVersions({
        from: r.entities.currentVersionId,
        to: r.entityVersions.id,
      }),
      createdByUser: r.one.user({
        from: r.entities.createdBy,
        to: r.user.id,
      }),
      searchDocument: r.one.searchDocuments({
        from: r.entities.id,
        to: r.searchDocuments.entityId,
      }),
      extractedContent: r.one.extractedContent({
        from: r.entities.id,
        to: r.extractedContent.entityId,
      }),
    },
    entityVersions: {
      entity: r.one.entities({
        from: r.entityVersions.entityId,
        to: r.entities.id,
      }),
      fields: r.many.fields({
        from: r.entityVersions.id,
        to: r.fields.entityVersionId,
      }),
    },
    fields: {
      entityVersion: r.one.entityVersions({
        from: r.fields.entityVersionId,
        to: r.entityVersions.id,
      }),
      property: r.one.properties({
        from: r.fields.propertyId,
        to: r.properties.id,
      }),
      justification: r.one.justifications({
        from: r.fields.id,
        to: r.justifications.fieldId,
      }),
    },
    views: {
      workspace: r.one.workspaces({
        from: r.views.workspaceId,
        to: r.workspaces.id,
      }),
    },
    justifications: {
      field: r.one.fields({
        from: r.justifications.fieldId,
        to: r.fields.id,
      }),
    },
    templates: {
      category: r.one.templateCategories({
        from: r.templates.categoryId,
        to: r.templateCategories.id,
      }),
      templateClauses: r.many.templateClauses({
        from: r.templates.id,
        to: r.templateClauses.templateId,
      }),
      versions: r.many.templateVersions({
        from: r.templates.id,
        to: r.templateVersions.templateId,
      }),
    },
    templateVersions: {
      template: r.one.templates({
        from: r.templateVersions.templateId,
        to: r.templates.id,
      }),
    },
    billingCodes: {
      workspace: r.one.workspaces({
        from: r.billingCodes.workspaceId,
        to: r.workspaces.id,
      }),
    },
    timeEntries: {
      workspace: r.one.workspaces({
        from: r.timeEntries.workspaceId,
        to: r.workspaces.id,
      }),
      matter: r.one.entities({
        from: r.timeEntries.matterId,
        to: r.entities.id,
      }),
      invoice: r.one.invoices({
        from: r.timeEntries.invoiceId,
        to: r.invoices.id,
      }),
    },
    rateTables: {
      workspace: r.one.workspaces({
        from: r.rateTables.workspaceId,
        to: r.workspaces.id,
      }),
      entries: r.many.rateEntries({
        from: r.rateTables.id,
        to: r.rateEntries.rateTableId,
      }),
    },
    rateEntries: {
      rateTable: r.one.rateTables({
        from: r.rateEntries.rateTableId,
        to: r.rateTables.id,
      }),
    },
    expenses: {
      workspace: r.one.workspaces({
        from: r.expenses.workspaceId,
        to: r.workspaces.id,
      }),
      matter: r.one.entities({
        from: r.expenses.matterId,
        to: r.entities.id,
      }),
      invoice: r.one.invoices({
        from: r.expenses.invoiceId,
        to: r.invoices.id,
      }),
    },
    invoices: {
      workspace: r.one.workspaces({
        from: r.invoices.workspaceId,
        to: r.workspaces.id,
      }),
      timeEntries: r.many.timeEntries({
        from: r.invoices.id,
        to: r.timeEntries.invoiceId,
      }),
      expenses: r.many.expenses({
        from: r.invoices.id,
        to: r.expenses.invoiceId,
      }),
    },
    matterCounters: {},
    organizationSettings: {},
    clauseCategories: {
      parent: r.one.clauseCategories({
        from: r.clauseCategories.parentId,
        to: r.clauseCategories.id,
        alias: "categoryParent",
      }),
      children: r.many.clauseCategories({
        from: r.clauseCategories.id,
        to: r.clauseCategories.parentId,
        alias: "categoryParent",
      }),
      clauses: r.many.clauses({
        from: r.clauseCategories.id,
        to: r.clauses.categoryId,
      }),
    },
    clauses: {
      category: r.one.clauseCategories({
        from: r.clauses.categoryId,
        to: r.clauseCategories.id,
      }),
      variants: r.many.clauseVariants({
        from: r.clauses.id,
        to: r.clauseVariants.clauseId,
      }),
      versions: r.many.clauseVersions({
        from: r.clauses.id,
        to: r.clauseVersions.clauseId,
      }),
      createdByUser: r.one.user({
        from: r.clauses.createdBy,
        to: r.user.id,
      }),
    },
    clauseVariants: {
      clause: r.one.clauses({
        from: r.clauseVariants.clauseId,
        to: r.clauses.id,
      }),
    },
    clauseVersions: {
      clause: r.one.clauses({
        from: r.clauseVersions.clauseId,
        to: r.clauses.id,
      }),
    },
    templateCategories: {
      parent: r.one.templateCategories({
        from: r.templateCategories.parentId,
        to: r.templateCategories.id,
        alias: "templateCategoryParent",
      }),
      children: r.many.templateCategories({
        from: r.templateCategories.id,
        to: r.templateCategories.parentId,
        alias: "templateCategoryParent",
      }),
      templates: r.many.templates({
        from: r.templateCategories.id,
        to: r.templates.categoryId,
      }),
    },
    templateFills: {
      template: r.one.templates({
        from: r.templateFills.templateId,
        to: r.templates.id,
      }),
      user: r.one.user({
        from: r.templateFills.userId,
        to: r.user.id,
      }),
    },
    templateClauses: {
      template: r.one.templates({
        from: r.templateClauses.templateId,
        to: r.templates.id,
      }),
      clause: r.one.clauses({
        from: r.templateClauses.clauseId,
        to: r.clauses.id,
      }),
      clauseVariant: r.one.clauseVariants({
        from: r.templateClauses.clauseVariantId,
        to: r.clauseVariants.id,
      }),
      clauseVersion: r.one.clauseVersions({
        from: r.templateClauses.clauseVersionId,
        to: r.clauseVersions.id,
      }),
    },
    searchDocuments: {
      entity: r.one.entities({
        from: r.searchDocuments.entityId,
        to: r.entities.id,
      }),
      workspace: r.one.workspaces({
        from: r.searchDocuments.workspaceId,
        to: r.workspaces.id,
      }),
    },
    extractedContent: {
      entity: r.one.entities({
        from: r.extractedContent.entityId,
        to: r.entities.id,
      }),
    },
  }),
);
