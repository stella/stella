import { panic } from "better-result";
import { defineRelations, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import * as p from "drizzle-orm/pg-core";
import { customType } from "drizzle-orm/pg-core";

import type { PersistedDecisionAnalysis } from "@stll/case-law/analysis";
import type { DocumentAst } from "@stll/case-law/document-ast";

import { organization, user } from "@/api/db/auth-schema";
import { jsonb } from "@/api/db/columns";
import {
  chatMessagePolicies,
  chatThreadPolicies,
  mcpConnectorPolicies,
  mcpOAuthStatePolicies,
  mcpOAuthClientPolicies,
  mcpUserConnectionPolicies,
  organizationCheck,
  orgPolicies,
  promptShortcutPolicies,
  stella,
  userPolicies,
  workspaceIdCheck,
  wsPolicies,
} from "@/api/db/rls";
import type {
  BankAccount,
  BillingAddress,
  BoundingBoxes,
  CellMetadata,
  ContactAddress,
  ContactEmail,
  ContactPersistedMetadata,
  ContactPhone,
  EntityKind,
  FieldContent,
  PropertyCondition,
  PropertyContent,
  PropertyTool,
} from "@/api/db/schema-validators";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import type {
  ChatMessageRole,
  PersistedChatMessageContent,
} from "@/api/handlers/chat/types";
import type { ClauseMetadata } from "@/api/handlers/clauses/metadata";
import type { ClauseBody } from "@/api/handlers/clauses/types";
import type { TemplateManifest } from "@/api/handlers/docx/types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import type { CentsAmount } from "@/api/lib/money";
import { unsafeCents } from "@/api/lib/money";
import type { ViewLayout } from "@/api/lib/views-schema";

/** Metadata stored on link entities created by the web clipper. */
export type LinkMetadata = {
  url: string;
  snippet?: string;
  citation?: string;
  jurisdiction?: string;
  sourceType?: string;
};

export type PdfBatesJustificationBlock = {
  kind: "pdf-bates";
  fileFieldId: SafeId<"field">;
  statements: {
    text: string;
    citations: {
      bates: string;
      pageNumber: number;
    }[];
  }[];
};

export type DocxFolioJustificationBlock = {
  kind: "docx-folio";
  fileFieldId: SafeId<"field">;
  statements: {
    text: string;
    /** Each cite carries the block's literal text captured at
     *  extraction time so the cell-click peek can render the quoted
     *  source without re-parsing the DOCX or fetching anything else.
     *  `blockId` lets a folio editor (Phase 2b) scroll to the same
     *  paragraph the chat editor would. */
    citations: {
      blockId: string;
      text: string;
    }[];
  }[];
};

export type JustificationBlock =
  | PdfBatesJustificationBlock
  | DocxFolioJustificationBlock;

export type JustificationContent = {
  version: 1;
  blocks: JustificationBlock[];
};

export type AgendaItemKind =
  | "deadline"
  | "event"
  | "hearing"
  | "meeting"
  | "task";

export type AgendaItemSource =
  | "api"
  | "calendar"
  | "email"
  | "import"
  | "infosoud"
  | "manual";

export type AgendaAvailability =
  | "busy"
  | "free"
  | "out_of_office"
  | "tentative"
  | "unknown"
  | "working_elsewhere";

export type AgendaSensitivity = "confidential" | "normal" | "private";

export type AgendaParticipant = {
  email: string | null;
  name: string | null;
};

export type AgendaAttendee = AgendaParticipant & {
  optional?: boolean;
  responseStatus?: string | null;
  type?: "optional" | "required" | "resource" | null;
};

export type AgendaRecurrence = {
  pattern: string | null;
  range: string | null;
  raw?: unknown;
};

export type AgendaExternalData = Record<string, unknown>;

export type SchedulerIntervalSchedule = {
  type: "interval";
  everyMs: number;
};

export type SchedulerDailySchedule = {
  type: "daily";
  hour: number;
  minute: number;
  timeZone: string;
};

export type SchedulerSchedule =
  | SchedulerDailySchedule
  | SchedulerIntervalSchedule;

export type SchedulerPayload = Record<string, unknown>;

export type PracticeJurisdiction = {
  countryCode: string;
  isPrimary: boolean;
};

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
    return panic(`Unexpected bytea driver value: ${typeof value}`);
  },
});

const safeWorkspaceId = (name: string) =>
  p.uuid(name).$type<SafeId<"workspace">>();

const safeOrganizationId = (name: string) =>
  p.varchar(name, { length: 128 }).$type<SafeId<"organization">>();

const safeUuid = <T extends SafeIdType>(name: string) =>
  p.uuid(name).$type<SafeId<T>>();

const centsColumn = (name: string) => p.integer(name).$type<CentsAmount>();

const pUuid = <T extends SafeIdType>() =>
  p
    .uuid()
    .$defaultFn(createSafeId<T>)
    .$type<SafeId<T>>();

/**
 * Property computation lifecycle. Two states only — there is no
 * "uninitialized" limbo that the workflow planner could silently
 * skip:
 *  - "stale" : value needs (re)computation; queued for the next
 *              workflow run. AI properties land here at creation
 *              and any time their inputs change.
 *  - "fresh" : value is current. Manual properties land here at
 *              creation; AI properties move here after a workflow
 *              run completes.
 *
 * Callers must pick a status explicitly when inserting (the schema
 * column has no default), so a future fourth state cannot be
 * introduced and silently default new rows into a planner-skipped
 * limbo.
 */
export const PROPERTY_STATUSES = ["stale", "fresh"] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

export const ENTITY_KINDS = [
  "document",
  "folder",
  "task",
  "message",
  "link",
] as const satisfies readonly EntityKind[];

export const TASK_ASSIGNEE_ROLES = ["assignee", "reviewer"] as const;

export const TIME_ENTRY_STATUSES = [
  "draft",
  "approved",
  "billed",
  "written_off",
] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];
/** Named constants for time entry and expense statuses
 *  (both tables share TIME_ENTRY_STATUSES). */
export const BILLING_STATUS = {
  DRAFT: "draft",
  APPROVED: "approved",
  BILLED: "billed",
  WRITTEN_OFF: "written_off",
} as const satisfies Record<string, TimeEntryStatus>;

export const EXPENSE_CATEGORIES = [
  "filing_fee",
  "expert_witness",
  "travel",
  "printing",
  "courier",
  "other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const TIME_ENTRY_SOURCES = ["manual", "timer"] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];
export const TIME_ENTRY_SOURCE = {
  MANUAL: "manual",
  TIMER: "timer",
} as const satisfies Record<string, TimeEntrySource>;

// -- Contacts --

export const contacts = p.pgTable(
  "contacts",
  {
    id: pUuid<"contact">().primaryKey(),
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
    emails: jsonb().$type<ContactEmail[]>(),
    phones: jsonb().$type<ContactPhone[]>(),
    addresses: jsonb().$type<ContactAddress[]>(),
    tags: p.text().array(),
    metadata: jsonb().$type<ContactPersistedMetadata | null>(),
    color: p.varchar({ length: 32 }),

    // Billing fields
    registrationNumber: p.varchar("registration_number", {
      length: 64,
    }),
    taxId: p.varchar("tax_id", { length: 64 }),
    bankAccounts: jsonb("bank_accounts").$type<BankAccount[]>(),
    billingAddress: jsonb("billing_address").$type<BillingAddress>(),
    defaultHourlyRate: centsColumn("default_hourly_rate"),
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
    ...orgPolicies(),
  ],
);

export type ContactType = (typeof contacts.type)["enumValues"][number];

export const contactRelationships = p.pgTable(
  "contact_relationships",
  {
    id: pUuid<"contactRelationship">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    personId: safeUuid<"contact">("person_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    relatedContactId: safeUuid<"contact">("related_contact_id")
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
    ...orgPolicies(),
  ],
);

// -- Workspaces --

export const workspaces = p.pgTable(
  "workspaces",
  {
    id: pUuid<"workspace">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    reference: p.varchar({ length: 64 }).notNull(),
    // Nullable: a null client_id encodes a personal matter (visible
    // only to the creator via workspace_members). A non-null client_id
    // is a normal client matter. Personal -> client is a one-way
    // promotion handled by the update endpoint.
    clientId: safeUuid<"contact">("client_id").references(() => contacts.id, {
      onDelete: "restrict",
    }),
    billingReference: p.varchar("billing_reference", {
      length: 128,
    }),
    color: p.varchar({ length: 32 }),
    status: p
      .text({ enum: ["active", "deleting", "archived"] })
      .notNull()
      .default("active"),
    lastActivityAt: p.timestamp("last_activity_at").notNull().defaultNow(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("workspaces_organization_id_idx").on(table.organizationId),
    p
      .unique("workspaces_org_reference_uidx")
      .on(table.organizationId, table.reference),
    p
      .index("workspaces_org_client_id_idx")
      .on(table.organizationId, table.clientId)
      .where(isNotNull(table.clientId)),
    p.pgPolicy("workspace_select", {
      for: "select",
      to: stella,
      using: workspaceIdCheck,
    }),
    p.pgPolicy("workspace_insert", {
      for: "insert",
      to: stella,
      withCheck: organizationCheck,
    }),
    p.pgPolicy("workspace_update", {
      for: "update",
      to: stella,
      using: workspaceIdCheck,
    }),
    p.pgPolicy("workspace_delete", {
      for: "delete",
      to: stella,
      using: workspaceIdCheck,
    }),
  ],
);

export const workspaceMembers = p.pgTable(
  "workspace_members",
  {
    id: pUuid<"workspaceMember">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .varchar("user_id", { length: 128 })
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("workspace_members_workspace_user_uidx")
      .on(table.workspaceId, table.userId),
    p.index("workspace_members_user_id_idx").on(table.userId),
    ...wsPolicies(),
  ],
);

export const workspaceContacts = p.pgTable(
  "workspace_contacts",
  {
    id: pUuid<"workspaceContact">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: safeUuid<"contact">("contact_id")
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
    ...wsPolicies(),
  ],
);

// -- Audit Logs --

export const auditLogs = p.pgTable(
  "audit_logs",
  {
    id: pUuid<"auditLog">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id"),
    userId: p.text("user_id").notNull(),
    action: p.text().notNull(),
    resourceType: p.text("resource_type").notNull(),
    resourceId: p.text("resource_id").notNull(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    changes: jsonb().$type<Record<string, unknown>>(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("audit_logs_org_created_id_idx")
      .on(table.organizationId, table.createdAt, table.id),
    p
      .index("audit_logs_org_workspace_created_id_idx")
      .on(table.organizationId, table.workspaceId, table.createdAt, table.id),
    p
      .index("audit_logs_org_resource_created_id_idx")
      .on(
        table.organizationId,
        table.resourceType,
        table.resourceId,
        table.createdAt,
        table.id,
      ),
    p
      .index("audit_logs_org_user_created_id_idx")
      .on(table.organizationId, table.userId, table.createdAt, table.id),
    p.pgPolicy("audit_logs_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("audit_logs_insert", {
      for: "insert",
      to: stella,
      withCheck: organizationCheck,
    }),
  ],
);

// -- Scheduler --

export const schedulerJobs = p.pgTable(
  "scheduler_jobs",
  {
    id: p.varchar({ length: 128 }).primaryKey(),
    task: p.varchar({ length: 128 }).notNull(),
    description: p.text(),
    schedule: jsonb().$type<SchedulerSchedule>().notNull(),
    payload: jsonb().$type<SchedulerPayload | null>(),
    enabled: p.boolean().notNull().default(true),
    nextRunAt: p.timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: p.timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: p.timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: p.timestamp("last_failure_at", { withTimezone: true }),
    lastError: p.text("last_error"),
    lockedAt: p.timestamp("locked_at", { withTimezone: true }),
    lockedUntil: p.timestamp("locked_until", { withTimezone: true }),
    lockedBy: p.varchar("locked_by", { length: 128 }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("scheduler_jobs_enabled_next_run_idx")
      .on(table.enabled, table.nextRunAt),
    p.index("scheduler_jobs_task_idx").on(table.task),
    p.index("scheduler_jobs_locked_until_idx").on(table.lockedUntil),
    p.pgPolicy("scheduler_jobs_no_stella_access", {
      for: "all",
      to: stella,
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
);

export const schedulerJobRuns = p.pgTable(
  "scheduler_job_runs",
  {
    id: pUuid<"schedulerJobRun">().primaryKey(),
    jobId: p
      .varchar("job_id", { length: 128 })
      .notNull()
      .references(() => schedulerJobs.id, { onDelete: "cascade" }),
    task: p.varchar({ length: 128 }).notNull(),
    runnerId: p.varchar("runner_id", { length: 128 }).notNull(),
    status: p
      .text({ enum: ["running", "success", "failed", "skipped"] })
      .notNull()
      .default("running"),
    startedAt: p
      .timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: p.timestamp("finished_at", { withTimezone: true }),
    durationMs: p.integer("duration_ms"),
    error: p.text(),
  },
  (table) => [
    p
      .index("scheduler_job_runs_job_started_idx")
      .on(table.jobId, table.startedAt),
    p
      .index("scheduler_job_runs_status_started_idx")
      .on(table.status, table.startedAt),
    p.pgPolicy("scheduler_job_runs_no_stella_access", {
      for: "all",
      to: stella,
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
);

// -- InfoSoud Tracking --

export const infoSoudTrackedCases = p.pgTable(
  "infosoud_tracked_cases",
  {
    id: pUuid<"infoSoudTrackedCase">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    courtCode: p.varchar("court_code", { length: 16 }).notNull(),
    spisZn: p.varchar("spis_zn", { length: 64 }).notNull(),
    enabled: p.boolean().notNull().default(true),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    lastSyncAttemptAt: p.timestamp("last_sync_attempt_at", {
      withTimezone: true,
    }),
    lastSyncedAt: p.timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: p.text("last_sync_error"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.index("infosoud_tracked_cases_workspace_idx").on(table.workspaceId),
    p
      .index("infosoud_tracked_cases_enabled_sync_idx")
      .on(table.enabled, table.lastSyncAttemptAt, table.id),
    p
      .uniqueIndex("infosoud_tracked_cases_workspace_case_uidx")
      .on(table.workspaceId, table.courtCode, table.spisZn),
    ...wsPolicies(),
  ],
);

// -- Properties --

export const properties = p.pgTable(
  "properties",
  {
    id: pUuid<"property">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    status: p.text("status", { enum: PROPERTY_STATUSES }).notNull(),
    content: jsonb().$type<PropertyContent>().notNull(),
    tool: jsonb().$type<PropertyTool>().notNull(),
    system: p.boolean().notNull().default(false),
    kinds: p.varchar({ length: 64 }).array().$type<EntityKind>(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("properties_workspace_id_idx").on(table.workspaceId),
    p.unique("properties_id_ws_unq").on(table.id, table.workspaceId),
    ...wsPolicies(),
  ],
);

export const propertyDependencies = p.pgTable(
  "property_dependencies",
  {
    id: pUuid<"propertyDependency">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    dependsOnPropertyId: safeUuid<"property">(
      "depends_on_property_id",
    ).notNull(),
    condition: jsonb().$type<PropertyCondition>(),
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
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.dependsOnPropertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("restrict"),
    p.index("property_dependencies_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);

// -- Entities --

export const entities = p.pgTable(
  "entities",
  {
    id: pUuid<"entity">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: p.text("kind", { enum: ENTITY_KINDS }).notNull().default("document"),
    parentId: safeUuid<"entity">("parent_id").references(
      (): AnyPgColumn => entities.id,
      {
        onDelete: "set null",
      },
    ),
    name: p.text("name").notNull(),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    lastEditedBy: p
      .text("last_edited_by")
      .references(() => user.id, { onDelete: "set null" }),
    currentVersionId: safeUuid<"entityVersion">(
      "current_version_id",
    ).references((): AnyPgColumn => entityVersions.id, {
      onDelete: "restrict",
    }),
    /** Sequential document number within the workspace (null for folders). */
    docSequence: p.integer("doc_sequence"),
    status: p.varchar({ length: 32 }),
    priority: p.varchar({ length: 16 }),
    dueDate: p.date("due_date", { mode: "string" }),
    agendaKind: p.text("agenda_kind", {
      enum: ["task", "deadline", "meeting", "hearing", "event"],
    }),
    startAt: p.timestamp("start_at", { withTimezone: true }),
    endAt: p.timestamp("end_at", { withTimezone: true }),
    occurredAt: p.timestamp("occurred_at", { withTimezone: true }),
    remindAt: p.timestamp("remind_at", { withTimezone: true }),
    allDay: p.boolean("all_day").notNull().default(false),
    timeZone: p.varchar("time_zone", { length: 64 }),
    location: p.text("location"),
    onlineMeetingUrl: p.text("online_meeting_url"),
    availability: p.text("availability", {
      enum: [
        "free",
        "tentative",
        "busy",
        "out_of_office",
        "working_elsewhere",
        "unknown",
      ],
    }),
    sensitivity: p.text("sensitivity", {
      enum: ["normal", "private", "confidential"],
    }),
    organizer: jsonb("organizer").$type<AgendaParticipant | null>(),
    attendees: jsonb("attendees").$type<AgendaAttendee[] | null>(),
    recurrence: jsonb("recurrence").$type<AgendaRecurrence | null>(),
    agendaSource: p.text("agenda_source", {
      enum: ["manual", "infosoud", "calendar", "email", "import", "api"],
    }),
    externalSource: p.varchar("external_source", { length: 64 }),
    externalId: p.varchar("external_id", { length: 256 }),
    externalChangeKey: p.varchar("external_change_key", { length: 512 }),
    externalICalUid: p.varchar("external_ical_uid", { length: 512 }),
    externalData: jsonb("external_data").$type<AgendaExternalData | null>(),
    readOnly: p.boolean("read_only").notNull().default(false),
    sortOrder: p.varchar("sort_order", { length: 64 }),
    /** Structured metadata for non-document entity kinds (e.g. links). */
    metadata: jsonb().$type<LinkMetadata | null>(),
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
    p
      .uniqueIndex("entities_ws_doc_seq_uidx")
      .on(table.workspaceId, table.docSequence)
      .where(isNotNull(table.docSequence)),
    p.unique("entities_id_ws_unq").on(table.id, table.workspaceId),
    p
      .index("entities_workspace_status_idx")
      .on(table.workspaceId, table.status)
      .where(isNotNull(table.status)),
    p
      .index("entities_workspace_priority_idx")
      .on(table.workspaceId, table.priority)
      .where(isNotNull(table.priority)),
    p
      .index("entities_due_date_idx")
      .on(table.workspaceId, table.dueDate)
      .where(isNotNull(table.dueDate)),
    p
      .index("entities_agenda_kind_idx")
      .on(table.workspaceId, table.agendaKind)
      .where(isNotNull(table.agendaKind)),
    p
      .index("entities_agenda_start_at_idx")
      .on(table.workspaceId, table.startAt)
      .where(isNotNull(table.startAt)),
    p
      .index("entities_agenda_occurred_at_idx")
      .on(table.workspaceId, table.occurredAt)
      .where(isNotNull(table.occurredAt)),
    p
      .uniqueIndex("entities_agenda_external_uidx")
      .on(table.workspaceId, table.externalSource, table.externalId)
      .where(isNotNull(table.externalId)),
    p
      .index("entities_agenda_ical_uid_idx")
      .on(table.workspaceId, table.externalICalUid)
      .where(isNotNull(table.externalICalUid)),
    ...wsPolicies(),
  ],
);

export const taskAssignees = p.pgTable(
  "task_assignees",
  {
    id: pUuid<"taskAssignee">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: p.text("role", { enum: TASK_ASSIGNEE_ROLES }).notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("task_assignees_workspace_id_idx").on(table.workspaceId),
    p.index("task_assignees_entity_id_idx").on(table.entityId),
    p.index("task_assignees_user_id_idx").on(table.userId),
    p
      .uniqueIndex("task_assignees_entity_user_uidx")
      .on(table.entityId, table.userId),
    ...wsPolicies(),
  ],
);

export const entityLinks = p.pgTable(
  "entity_links",
  {
    id: pUuid<"entityLink">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceEntityId: safeUuid<"entity">("source_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    targetEntityId: safeUuid<"entity">("target_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    linkType: p
      .varchar("link_type", { length: 32 })
      .notNull()
      .default("related"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("entity_links_workspace_id_idx").on(table.workspaceId),
    p.index("entity_links_source_idx").on(table.sourceEntityId),
    p.index("entity_links_target_idx").on(table.targetEntityId),
    p
      .uniqueIndex("entity_links_source_target_uidx")
      .on(table.sourceEntityId, table.targetEntityId),
    p
      .uniqueIndex("entity_links_pair_uidx")
      .using(
        "btree",
        sql`LEAST(${table.sourceEntityId}, ${table.targetEntityId})`,
        sql`GREATEST(${table.sourceEntityId}, ${table.targetEntityId})`,
      ),
    p.check(
      "entity_links_no_self_ref_check",
      sql`${table.sourceEntityId} != ${table.targetEntityId}`,
    ),
    ...wsPolicies(),
  ],
);

export const entityVersions = p.pgTable(
  "entity_versions",
  {
    id: pUuid<"entityVersion">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    versionNumber: p.integer("version_number").notNull().default(1),
    /** Frozen human-readable reference (e.g. "2026/001/015.v3"). */
    stamp: p.varchar("stamp", { length: 128 }),
    /** User-assigned workflow label (e.g. "Internal draft", "Final version"). */
    label: p.varchar("label", { length: 128 }),
    /** Free-text note describing this version. */
    description: p.varchar("description", { length: 1024 }),
    /** Word-level diff stats vs previous version (computed on finalization). */
    diffWordsAdded: p.integer("diff_words_added"),
    diffWordsRemoved: p.integer("diff_words_removed"),
    /** Globally unique verification code (no stl: prefix). */
    verificationCode: p.varchar("verification_code", {
      length: 16,
    }),
    /** User who created this version (uploader, desktop editor, or restorer). */
    createdBy: p.text("created_by"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("entity_versions_entity_id_idx").on(table.entityId),
    p
      .index("entity_versions_stamp_idx")
      .on(table.stamp)
      .where(isNotNull(table.stamp)),
    p
      .uniqueIndex("entity_versions_vcode_uidx")
      .on(table.verificationCode)
      .where(isNotNull(table.verificationCode)),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p.index("entity_versions_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);

export const entityVersionAiSummaries = p.pgTable(
  "entity_version_ai_summaries",
  {
    id: pUuid<"entityVersionAiSummary">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    promptVersion: p.smallint("prompt_version").notNull(),
    sourceTextHash: p.varchar("source_text_hash", { length: 64 }).notNull(),
    summary: p.text().notNull(),
    language: p.varchar("language", { length: 10 }),
    modelProvider: p.varchar("model_provider", { length: 64 }).notNull(),
    modelId: p.varchar("model_id", { length: 256 }).notNull(),
    generatedAt: p.timestamp("generated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("entity_version_ai_summaries_workspace_idx").on(table.workspaceId),
    p.index("entity_version_ai_summaries_entity_idx").on(table.entityId),
    p
      .uniqueIndex("entity_version_ai_summaries_version_prompt_uidx")
      .on(table.entityVersionId, table.promptVersion),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    ...wsPolicies(),
  ],
);

export const DESKTOP_EDIT_SESSION_STATUSES = [
  "open",
  "finalized",
  "cancelled",
] as const;

export const desktopEditSessions = p.pgTable(
  "desktop_edit_sessions",
  {
    id: pUuid<"desktopEditSession">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    baseVersionId: safeUuid<"entityVersion">("base_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    finalizedVersionId: safeUuid<"entityVersion">(
      "finalized_version_id",
    ).references(() => entityVersions.id, { onDelete: "set null" }),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: p
      .text("status", { enum: DESKTOP_EDIT_SESSION_STATUSES })
      .notNull()
      .default("open"),
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    checkpointFileId: safeUuid<"userFile">("checkpoint_file_id").notNull(),
    checkpointSha256Hex: p.varchar("checkpoint_sha256_hex", { length: 64 }),
    checkpointSizeBytes: p.integer("checkpoint_size_bytes"),
    checkpointScanWarnings: jsonb("checkpoint_scan_warnings").$type<
      string[] | null
    >(),
    checkpointUpdatedAt: p.timestamp("checkpoint_updated_at"),
    sessionTokenHash: p.varchar("session_token_hash", { length: 64 }).notNull(),
    tokenExpiresAt: p.timestamp("token_expires_at").notNull(),
    takeoverRequestedBy: p
      .text("takeover_requested_by")
      .references(() => user.id, { onDelete: "set null" }),
    takeoverRequestedAt: p.timestamp("takeover_requested_at"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: p.timestamp("closed_at"),
  },
  (table) => [
    p.index("desktop_edit_sessions_workspace_id_idx").on(table.workspaceId),
    p.index("desktop_edit_sessions_entity_id_idx").on(table.entityId),
    p.index("desktop_edit_sessions_property_id_idx").on(table.propertyId),
    p
      .index("desktop_edit_sessions_base_version_id_idx")
      .on(table.baseVersionId),
    p
      .uniqueIndex("desktop_edit_sessions_session_token_hash_uidx")
      .on(table.sessionTokenHash),
    p
      .uniqueIndex("desktop_edit_sessions_open_uidx")
      .on(table.createdBy, table.entityId, table.propertyId)
      .where(sql`${table.status} = 'open'`),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    ...wsPolicies(),
  ],
);

export const fields = p.pgTable(
  "fields",
  {
    id: pUuid<"field">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    fileId: safeUuid<"userFile">("file_id"),
    content: jsonb().$type<FieldContent>().notNull(),
  },
  (table) => [
    p
      .uniqueIndex("fields_property_id_entity_version_id_key")
      .on(table.propertyId, table.entityVersionId),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    p.index("fields_workspace_id_idx").on(table.workspaceId),
    p.unique("fields_id_ws_unq").on(table.id, table.workspaceId),
    ...wsPolicies(),
  ],
);

export const cellMetadata = p.pgTable(
  "cell_metadata",
  {
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    entityVersionId: safeUuid<"entityVersion">("entity_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    propertyId: safeUuid<"property">("property_id").notNull(),
    metadata: jsonb().$type<CellMetadata>().notNull(),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    updatedBy: p
      .text("updated_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.entityVersionId, table.propertyId],
      name: "cell_metadata_entity_version_id_property_id_pk",
    }),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
      })
      .onDelete("cascade"),
    p.index("cell_metadata_workspace_id_idx").on(table.workspaceId),
    p.index("cell_metadata_entity_version_id_idx").on(table.entityVersionId),
    ...wsPolicies(),
  ],
);

export const justifications = p.pgTable(
  "justifications",
  {
    id: pUuid<"justification">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").notNull(),
    fieldId: safeUuid<"field">("field_id").notNull(),
    content: jsonb().$type<JustificationContent>().notNull(),
    boundingBoxes: jsonb("bounding_boxes").$type<BoundingBoxes>(),
    fileFieldIds: safeUuid<"field">("file_field_ids")
      .array()
      .notNull()
      .default([]),
  },
  (table) => [
    p.uniqueIndex("justifications_field_id_key").on(table.fieldId),
    p
      .foreignKey({
        columns: [table.fieldId, table.workspaceId],
        foreignColumns: [fields.id, fields.workspaceId],
      })
      .onDelete("cascade"),
    p.index("justifications_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies(),
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
    fileName: p.varchar("file_name", { length: 256 }).notNull(),
    s3Key: p.varchar("s3_key", { length: 512 }).notNull(),
    sizeBytes: p.integer("size_bytes").notNull(),
    manifest: jsonb().$type<TemplateManifest>(),
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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
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
    tsv: tsvector(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("search_documents_org_id_idx").on(table.organizationId),
    p
      .index("search_documents_org_workspace_idx")
      .on(table.organizationId, table.workspaceId),
    p.index("search_documents_tsv_idx").using("gin", table.tsv),
    ...wsPolicies(),
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
    tsv: tsvector(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("contact_search_docs_org_idx").on(table.organizationId),
    p
      .index("contact_search_docs_org_type_idx")
      .on(table.organizationId, table.contactType),
    p.index("contact_search_docs_tsv_idx").using("gin", table.tsv),
    ...orgPolicies(),
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
    tsv: tsvector(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("workspace_search_docs_org_idx").on(table.organizationId),
    p.index("workspace_search_docs_tsv_idx").using("gin", table.tsv),
    ...wsPolicies(),
  ],
);

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
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    charCount: p.integer("char_count").notNull(),
    language: p.varchar("language", { length: 10 }),
    extractedAt: p.timestamp("extracted_at").notNull().defaultNow(),
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
    ...wsPolicies(),
  ],
);

export const timeEntries = p.pgTable(
  "time_entries",
  {
    id: pUuid<"timeEntry">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .references(() => user.id, { onDelete: "set null" }),
    matterId: safeUuid<"entity">("matter_id")
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    dateWorked: p.date("date_worked").notNull(),
    timezoneId: p.text("timezone_id").notNull(),
    durationMinutes: p.integer("duration_minutes").notNull(),
    billedMinutes: p.integer("billed_minutes").notNull(),
    rateAtEntry: centsColumn("rate_at_entry").notNull(),
    currency: p.varchar({ length: 3 }).notNull(),
    narrative: p.text().notNull(),
    invoiceNarrative: p.text("invoice_narrative"),
    billable: p.boolean().notNull().default(true),
    noCharge: p.boolean("no_charge").notNull().default(false),
    status: p
      .text("status", { enum: TIME_ENTRY_STATUSES })
      .notNull()
      .default("draft"),
    source: p
      .text("source", { enum: TIME_ENTRY_SOURCES })
      .notNull()
      .default("manual"),
    taskCode: p.varchar("task_code", { length: 20 }),
    activityCode: p.varchar("activity_code", { length: 20 }),
    invoiceId: safeUuid<"invoice">("invoice_id").references(() => invoices.id, {
      onDelete: "set null",
    }),
    splitGroupId: safeUuid<"timeEntry">("split_group_id"),
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
    ...wsPolicies(),
  ],
);

export const BILLING_CODE_TYPES = ["task", "activity"] as const;

export const billingCodes = p.pgTable(
  "billing_codes",
  {
    id: pUuid<"billingCode">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: p.text("type", { enum: BILLING_CODE_TYPES }).notNull(),
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
    ...wsPolicies(),
  ],
);

export const rateTables = p.pgTable(
  "rate_tables",
  {
    id: pUuid<"rateTable">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    currency: p.varchar({ length: 3 }).notNull(),
    isDefault: p.boolean("is_default").notNull().default(false),
    clientId: safeUuid<"contact">("client_id"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("rate_tables_ws_default_idx")
      .on(table.workspaceId, table.isDefault),
    p.index("rate_tables_ws_client_idx").on(table.workspaceId, table.clientId),
    ...wsPolicies(),
  ],
);

export const rateEntries = p.pgTable(
  "rate_entries",
  {
    id: pUuid<"rateEntry">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    rateTableId: safeUuid<"rateTable">("rate_table_id")
      .notNull()
      .references(() => rateTables.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .references(() => user.id, { onDelete: "cascade" }),
    hourlyRate: centsColumn("hourly_rate").notNull(),
    effectiveFrom: p.date("effective_from").notNull(),
    effectiveTo: p.date("effective_to"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("rate_entries_table_user_from_idx")
      .on(table.rateTableId, table.userId, table.effectiveFrom),
    p.index("rate_entries_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);

export const expenses = p.pgTable(
  "expenses",
  {
    id: pUuid<"expense">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .references(() => user.id, { onDelete: "set null" }),
    matterId: safeUuid<"entity">("matter_id")
      .notNull()
      .references(() => entities.id, { onDelete: "restrict" }),
    dateIncurred: p.date("date_incurred").notNull(),
    amount: centsColumn("amount").notNull(),
    currency: p.varchar({ length: 3 }).notNull(),
    category: p.text("category", { enum: EXPENSE_CATEGORIES }).notNull(),
    description: p.text().notNull(),
    invoiceDescription: p.text("invoice_description"),
    billable: p.boolean().notNull().default(true),
    markup: p.integer().notNull().default(0),
    status: p
      .text("status", { enum: TIME_ENTRY_STATUSES })
      .notNull()
      .default("draft"),
    invoiceId: safeUuid<"invoice">("invoice_id").references(() => invoices.id, {
      onDelete: "set null",
    }),
    receiptFileId: safeUuid<"userFile">("receipt_file_id"),
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
    ...wsPolicies(),
  ],
);

export const INVOICE_STATUSES = [
  "draft",
  "finalized",
  "sent",
  "paid",
  "void",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

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
    id: pUuid<"invoice">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    invoiceNumber: p.varchar("invoice_number", { length: 64 }).notNull(),
    reference: p.varchar({ length: 256 }),
    status: p
      .text("status", { enum: INVOICE_STATUSES })
      .notNull()
      .default("draft"),
    invoiceDate: p.date("invoice_date").notNull(),
    dueDate: p.date("due_date"),
    currency: p.varchar({ length: 3 }).notNull(),
    // SAFETY: literal zero is a valid minor-unit integer default.
    totalAmount: centsColumn("total_amount").notNull().default(unsafeCents(0)),
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
    ...wsPolicies(),
  ],
);

export const matterCounters = p.pgTable(
  "matter_counters",
  {
    id: pUuid<"matterCounter">().primaryKey(),
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
    ...orgPolicies(),
  ],
);

export const documentCounters = p.pgTable(
  "document_counters",
  {
    id: pUuid<"documentCounter">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    lastValue: p.integer("last_value").notNull().default(0),
  },
  (table) => [
    p.uniqueIndex("document_counters_ws_uidx").on(table.workspaceId),
    ...wsPolicies(),
  ],
);

export const organizationSettings = p.pgTable(
  "organization_settings",
  {
    id: pUuid<"organizationSettings">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: "cascade" }),
    matterNumberPattern: p
      .varchar("matter_number_pattern", { length: 128 })
      .notNull()
      .default("{SEQ}"),
    matterNumberPadding: p
      .integer("matter_number_padding")
      .notNull()
      .default(3),
    documentStampEnabled: p
      .boolean("document_stamp_enabled")
      .notNull()
      .default(true),
    practiceJurisdictions: jsonb("practice_jurisdictions")
      .$type<PracticeJurisdiction[]>()
      .notNull()
      .default([]),
    /** Native tool slugs the org has disabled in chat. */
    disabledNativeTools: jsonb("disabled_native_tools")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Encrypted OrgAIConfig JSON (AES-256-GCM). */
    aiConfigEncrypted: bytea("ai_config_encrypted"),
    /** AES-GCM initialization vector for aiConfigEncrypted. */
    aiConfigIv: bytea("ai_config_iv"),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  () => [...orgPolicies()],
);

export const anonymizationBlacklistEntries = p.pgTable(
  "anonymization_blacklist_entries",
  {
    id: pUuid<"anonymizationBlacklistEntry">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    label: p.varchar({ length: 64 }).notNull(),
    canonical: p.varchar({ length: 512 }).notNull(),
    variants: jsonb().$type<string[]>().notNull().default([]),
    enabled: p.boolean().notNull().default(true),
    createdBy: p
      .text("created_by")
      .references(() => user.id, { onDelete: "set null" }),
    updatedBy: p
      .text("updated_by")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("anonymization_blacklist_entries_org_enabled_idx")
      .on(table.organizationId, table.enabled),
    p
      .uniqueIndex("anonymization_blacklist_entries_org_canonical_uidx")
      .on(table.organizationId, sql`lower(${table.canonical})`),
    ...orgPolicies(),
  ],
);

export const clauseCategories = p.pgTable(
  "clause_categories",
  {
    id: pUuid<"clauseCategory">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    parentId: safeUuid<"clauseCategory">("parent_id").references(
      (): AnyPgColumn => clauseCategories.id,
      {
        onDelete: "set null",
      },
    ),
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
    ...orgPolicies(),
  ],
);

export const clauses = p.pgTable(
  "clauses",
  {
    id: pUuid<"clause">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    categoryId: safeUuid<"clauseCategory">("category_id").references(
      () => clauseCategories.id,
      {
        onDelete: "set null",
      },
    ),
    title: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    usageNotes: p.text("usage_notes"),
    language: p.varchar({ length: 10 }),
    body: jsonb().$type<ClauseBody>().notNull(),
    metadata: jsonb().$type<ClauseMetadata | null>(),
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
    p.unique("clauses_id_org_unq").on(table.id, table.organizationId),
    ...orgPolicies(),
  ],
);

export const clauseVariants = p.pgTable(
  "clause_variants",
  {
    id: pUuid<"clauseVariant">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    clauseId: safeUuid<"clause">("clause_id").notNull(),
    label: p.varchar({ length: 256 }).notNull(),
    body: jsonb().$type<ClauseBody>().notNull(),
    sortOrder: p.integer("sort_order").notNull().default(0),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("clause_variants_clause_id_idx").on(table.clauseId),
    p
      .foreignKey({
        columns: [table.clauseId, table.organizationId],
        foreignColumns: [clauses.id, clauses.organizationId],
      })
      .onDelete("cascade"),
    p.index("clause_variants_organization_id_idx").on(table.organizationId),
    ...orgPolicies(),
  ],
);

export const clauseVersions = p.pgTable(
  "clause_versions",
  {
    id: pUuid<"clauseVersion">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    clauseId: safeUuid<"clause">("clause_id").notNull(),
    version: p.integer().notNull(),
    body: jsonb().$type<ClauseBody>().notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("clause_versions_clause_version_uidx")
      .on(table.clauseId, table.version),
    p
      .foreignKey({
        columns: [table.clauseId, table.organizationId],
        foreignColumns: [clauses.id, clauses.organizationId],
      })
      .onDelete("cascade"),
    p.index("clause_versions_organization_id_idx").on(table.organizationId),
    ...orgPolicies(),
  ],
);

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
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("template_categories_organization_id_idx").on(table.organizationId),
    p
      .index("template_categories_org_parent_idx")
      .on(table.organizationId, table.parentId),
    ...orgPolicies(),
  ],
);

export const templateClauses = p.pgTable(
  "template_clauses",
  {
    id: pUuid<"templateClause">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    templateId: safeUuid<"template">("template_id").notNull(),
    clauseId: safeUuid<"clause">("clause_id").references(() => clauses.id, {
      onDelete: "set null",
    }),
    clauseVariantId: safeUuid<"clauseVariant">("clause_variant_id").references(
      () => clauseVariants.id,
      {
        onDelete: "set null",
      },
    ),
    clauseVersionId: safeUuid<"clauseVersion">("clause_version_id").references(
      () => clauseVersions.id,
      {
        onDelete: "set null",
      },
    ),
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
    p
      .foreignKey({
        columns: [table.templateId, table.organizationId],
        foreignColumns: [templates.id, templates.organizationId],
      })
      .onDelete("cascade"),
    p.index("template_clauses_organization_id_idx").on(table.organizationId),
    ...orgPolicies(),
  ],
);

// -- Template Fills (analytics) --

export const templateFills = p.pgTable(
  "template_fills",
  {
    id: pUuid<"templateFill">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    templateId: safeUuid<"template">("template_id").references(
      () => templates.id,
      { onDelete: "set null" },
    ),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    format: p.text().notNull(),
    status: p.text().notNull(),
    unmatchedCount: p.integer("unmatched_count").notNull().default(0),
    unusedCount: p.integer("unused_count").notNull().default(0),
    structureErrors: jsonb("structure_errors").$type<
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
    ...orgPolicies(),
  ],
);

// ---------------------------------------------------------------------------
// Case Law — Global tables (no organizationId)
// ---------------------------------------------------------------------------

export const caseLawSources = p.pgTable(
  "case_law_sources",
  {
    id: pUuid<"caseLawSource">().primaryKey(),
    adapterKey: p.varchar("adapter_key", { length: 64 }).notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    enabled: p.boolean().default(true).notNull(),
    syncCursor: p.text("sync_cursor"),
    lastSyncAt: p.timestamp("last_sync_at"),
    config: jsonb().$type<Record<string, unknown>>().default({}),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
    updatedAt: p
      .timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [p.uniqueIndex("case_law_sources_adapter_key_idx").on(t.adapterKey)],
);

export const caseLawDecisions = p.pgTable(
  "case_law_decisions",
  {
    id: pUuid<"caseLawDecision">().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    caseNumber: p.varchar("case_number", { length: 256 }).notNull(),
    slug: p.varchar({ length: 256 }),
    ecli: p.varchar({ length: 256 }),
    court: p.varchar({ length: 512 }).notNull(),
    country: p.varchar({ length: 3 }).notNull(),
    language: p.varchar({ length: 8 }).notNull(),
    languageGroupKey: p.varchar("language_group_key", {
      length: 512,
    }),
    decisionDate: p.date("decision_date"),
    decisionType: p.varchar("decision_type", { length: 128 }),
    fulltext: p.text(),
    sections: jsonb().$type<DecisionSection[]>(),
    documentAst: jsonb("document_ast").$type<DocumentAst | EmptyAst>(),
    /**
     * AI-generated structural analysis: hierarchical headings
     * with annotations anchored to paragraph ranges. Generated
     * on-demand on first open, persisted permanently.
     * null = not yet generated.
     */
    analysis: jsonb().$type<PersistedDecisionAnalysis>(),
    /**
     * Parser version that produced documentAst. Compared
     * against the adapter's current version on read; stale
     * ASTs are re-parsed lazily from sourceRaw in S3.
     */
    parserVersion: p.smallint("parser_version").default(0),
    /**
     * Raw source HTML/JSON from the court website, stored
     * verbatim for future re-parsing without re-downloading.
     * Compressed at the application level if needed.
     */
    sourceRaw: p.text("source_raw"),
    sourceRawS3Key: p.varchar("source_raw_s3_key", {
      length: 512,
    }),
    sourceRawContentType: p.varchar("source_raw_content_type", { length: 128 }),
    sourceUrl: p.varchar("source_url", { length: 2048 }),
    documentUrl: p.varchar("document_url", { length: 2048 }),
    metadata: jsonb().$type<Record<string, unknown>>().default({}),
    sourceHash: p.varchar("source_hash", { length: 64 }),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
    updatedAt: p
      .timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p
      .uniqueIndex("case_law_decisions_source_case_lang_idx")
      .on(t.sourceId, t.caseNumber, t.language),
    p.index("case_law_decisions_case_number_idx").on(t.caseNumber),
    p.index("case_law_decisions_court_idx").on(t.court),
    p.index("case_law_decisions_country_idx").on(t.country),
    p.index("case_law_decisions_date_idx").on(t.decisionDate),
    p.index("case_law_decisions_ecli_idx").on(t.ecli).where(isNotNull(t.ecli)),
    p
      .index("case_law_decisions_lang_group_idx")
      .on(t.languageGroupKey)
      .where(isNotNull(t.languageGroupKey)),
    p.index("case_law_decisions_created_at_idx").on(t.createdAt),
  ],
);

export const caseLawCitations = p.pgTable(
  "case_law_citations",
  {
    id: pUuid<"caseLawCitation">().primaryKey(),
    citingDecisionId: safeUuid<"caseLawDecision">("citing_decision_id")
      .notNull()
      .references(() => caseLawDecisions.id, { onDelete: "cascade" }),
    citedDecisionId: safeUuid<"caseLawDecision">(
      "cited_decision_id",
    ).references(() => caseLawDecisions.id, {
      onDelete: "set null",
    }),
    citationText: p.varchar("citation_text", { length: 512 }).notNull(),
    sectionIndex: p.integer("section_index"),
    polarity: p.varchar("polarity", { length: 16 }),
    polarityRuleId: safeUuid<"caseLawPolarityRule">(
      "polarity_rule_id",
    ).references(() => caseLawPolarityRules.id, {
      onDelete: "set null",
    }),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("case_law_citations_citing_idx").on(t.citingDecisionId),
    p
      .index("case_law_citations_cited_idx")
      .on(t.citedDecisionId)
      .where(isNotNull(t.citedDecisionId)),
    p
      .index("case_law_citations_polarity_null_idx")
      .on(t.polarity)
      .where(isNull(t.polarity)),
    p.check(
      "citations_polarity_values",
      sql`${t.polarity} IN ('positive','supportive','neutral','negative','unknown')`,
    ),
  ],
);

export const caseLawPolarityRules = p.pgTable(
  "case_law_polarity_rules",
  {
    id: pUuid<"caseLawPolarityRule">().primaryKey(),
    pattern: p.varchar("pattern", { length: 512 }).notNull(),
    polarity: p.varchar("polarity", { length: 16 }).notNull(),
    language: p.varchar("language", { length: 8 }).notNull(),
    source: p.varchar("source", { length: 16 }).notNull().default("manual"),
    confidence: p.doublePrecision("confidence").notNull().default(1),
    matchCount: p.integer("match_count").notNull().default(0),
    surfaceForms: jsonb("surface_forms").$type<string[]>().default([]),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
    updatedAt: p
      .timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.index("case_law_polarity_rules_lang_idx").on(t.language),
    p
      .uniqueIndex("case_law_polarity_rules_pattern_lang_idx")
      .on(t.pattern, t.language),
    p.check(
      "polarity_rules_polarity_values",
      sql`${t.polarity} IN ('positive','supportive','neutral','negative','unknown')`,
    ),
    p.check(
      "polarity_rules_source_values",
      sql`${t.source} IN ('manual','llm-proposed','llm-promoted')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Case Law — Tenant-scoped tables
// ---------------------------------------------------------------------------

export const caseLawMatterLinks = p.pgTable(
  "case_law_matter_links",
  {
    id: pUuid<"caseLawMatterLink">().primaryKey(),
    decisionId: safeUuid<"caseLawDecision">("decision_id")
      .notNull()
      .references(() => caseLawDecisions.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    note: p.text(),
    linkedBy: p
      .text("linked_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .uniqueIndex("case_law_matter_links_decision_ws_idx")
      .on(t.decisionId, t.workspaceId),
    p.index("case_law_matter_links_workspace_idx").on(t.workspaceId),
    ...wsPolicies(),
  ],
);

// ---------------------------------------------------------------------------
// Case Law — Search index (global, no tenant column)
// ---------------------------------------------------------------------------

export const caseLawCourtWeights = p.pgTable(
  "case_law_court_weights",
  {
    id: pUuid<"caseLawCourtWeight">().primaryKey(),
    country: p.varchar({ length: 3 }).notNull(),
    courtPattern: p.varchar("court_pattern", { length: 512 }).notNull(),
    tier: p.integer().notNull(),
    tierLabel: p.varchar("tier_label", { length: 64 }).notNull(),
    weight: p.doublePrecision().notNull(),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .uniqueIndex("case_law_court_weights_country_pattern_idx")
      .on(t.country, t.courtPattern),
    p.index("case_law_court_weights_country_idx").on(t.country),
  ],
);

export const caseLawFtsConfigs = p.pgTable("case_law_fts_configs", {
  language: p.varchar({ length: 8 }).primaryKey(),
  regconfig: p.varchar({ length: 64 }).notNull(),
  useUnaccent: p.boolean("use_unaccent").notNull().default(true),
});

export const caseLawSearchDocuments = p.pgTable(
  "case_law_search_documents",
  {
    decisionId: safeUuid<"caseLawDecision">("decision_id")
      .primaryKey()
      .references(() => caseLawDecisions.id, {
        onDelete: "cascade",
      }),
    title: p.text().notNull().default(""),
    searchableText: p.text("searchable_text").notNull().default(""),
    language: p.varchar("language", { length: 10 }),
    regconfig: p.varchar({ length: 64 }).notNull().default("simple"),
    tsv: tsvector(),
    updatedAt: p.timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [p.index("case_law_search_docs_tsv_idx").using("gin", table.tsv)],
);

// ---------------------------------------------------------------------------
// Case Law — Ingestion observability
// ---------------------------------------------------------------------------

export const caseLawIngestionEvents = p.pgTable(
  "case_law_ingestion_events",
  {
    id: pUuid<"caseLawIngestionEvent">().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    status: p.varchar({ length: 16 }).notNull().$type<"completed" | "failed">(),
    inserted: p.integer().notNull().default(0),
    skipped: p.integer().notNull().default(0),
    searchVectorFailures: p
      .integer("search_vector_failures")
      .notNull()
      .default(0),
    pagesProcessed: p.integer("pages_processed").notNull().default(0),
    cursorBefore: p.text("cursor_before"),
    cursorAfter: p.text("cursor_after"),
    durationMs: p.integer("duration_ms").notNull(),
    errorMessage: p.varchar("error_message", { length: 2048 }),
    startedAt: p.timestamp("started_at").notNull(),
    finishedAt: p.timestamp("finished_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("case_law_ingestion_events_source_idx").on(t.sourceId),
    p.index("case_law_ingestion_events_finished_idx").on(t.finishedAt),
  ],
);

export const caseLawIngestionFailures = p.pgTable(
  "case_law_ingestion_failures",
  {
    id: pUuid<"caseLawIngestionFailure">().primaryKey(),
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    caseNumber: p.varchar("case_number", { length: 256 }).notNull(),
    language: p.varchar({ length: 8 }),
    errorType: p.varchar("error_type", { length: 128 }).notNull(),
    errorMessage: p.varchar("error_message", { length: 2048 }).notNull(),
    cursor: p.text(),
    createdAt: p.timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.index("case_law_ingestion_failures_source_idx").on(t.sourceId),
    p.index("case_law_ingestion_failures_error_type_idx").on(t.errorType),
    p.index("case_law_ingestion_failures_created_idx").on(t.createdAt),
  ],
);

// -- Chat --

export const chatThreads = p.pgTable(
  "chat_threads",
  {
    id: pUuid<"chatThread">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      {
        onDelete: "restrict",
      },
    ),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    title: p.varchar({ length: 255 }).notNull(),
    /**
     * Matters the chat draws context from. Empty array (the
     * default) means "no specific matters pinned" — the AI
     * discovers matters lazily via the readonly stella API.
     * Non-empty narrows tool authorization so requested matterRefs
     * must be a subset of this set. Distinct from `workspaceId`,
     * which is the matter the chat itself lives under (or null
     * for global threads).
     */
    contextMatterIds: safeWorkspaceId("context_matter_ids")
      .array()
      .notNull()
      .default([]),
    /**
     * Workspaces whose content (citations, document excerpts) is
     * embedded in this thread. Empty means "no workspace data
     * embedded" (true global chat). Any non-empty value gates RLS
     * reads: the user's session workspace IDs must be a superset.
     * Used by search-summary chats so the stored summary cannot
     * outlive the user's access to a contributing matter.
     */
    dataWorkspaceIds: safeWorkspaceId("data_workspace_ids")
      .array()
      .notNull()
      .default([]),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("chat_threads_workspace_user_idx")
      .on(table.workspaceId, table.userId),
    p
      .index("chat_threads_organization_user_idx")
      .on(table.organizationId, table.userId),
    p.index("chat_threads_user_updated_idx").on(table.userId, table.updatedAt),
    ...chatThreadPolicies(),
  ],
);

export const chatMessages = p.pgTable(
  "chat_messages",
  {
    id: pUuid<"chatMessage">().primaryKey(),
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreads.id, {
        onDelete: "cascade",
      }),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      {
        onDelete: "restrict",
      },
    ),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: p.varchar({ length: 16 }).notNull().$type<ChatMessageRole>(),
    content: jsonb().notNull().$type<PersistedChatMessageContent>(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("chat_messages_thread_created_idx")
      .on(table.threadId, table.createdAt),
    p
      .index("chat_messages_user_workspace_created_idx")
      .on(table.userId, table.workspaceId, table.createdAt),
    ...chatMessagePolicies(),
  ],
);

// -- MCP Connectors --

export const MCP_CONNECTOR_AUTH_TYPES = ["none", "bearer", "oauth2"] as const;
export type McpConnectorAuthType = (typeof MCP_CONNECTOR_AUTH_TYPES)[number];

export const MCP_CONNECTION_STATUSES = [
  "connected",
  "needs_reauth",
  "revoked",
] as const;
export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number];

export type McpOAuthRegistrationResponse = Record<string, unknown>;

export const mcpConnectors = p.pgTable(
  "mcp_connectors",
  {
    id: pUuid<"mcpConnector">().primaryKey(),
    slug: p.varchar({ length: 80 }).notNull(),
    organizationId: safeOrganizationId("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    displayName: p.varchar("display_name", { length: 160 }).notNull(),
    description: p.text().notNull(),
    url: p.text().notNull(),
    authType: p
      .text("auth_type", { enum: MCP_CONNECTOR_AUTH_TYPES })
      .notNull()
      .$type<McpConnectorAuthType>(),
    isCurated: p.boolean("is_curated").notNull().default(false),
    oauthRequestedScopes: p.text("oauth_requested_scopes").array(),
    allowedTools: p.text("allowed_tools").array(),
    documentationUrl: p.text("documentation_url"),
    tokenHelpUrl: p.text("token_help_url"),
    iconUrl: p.text("icon_url"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("mcp_connectors_curated_slug_uidx")
      .on(table.slug)
      .where(isNull(table.organizationId)),
    p
      .uniqueIndex("mcp_connectors_custom_org_slug_uidx")
      .on(table.organizationId, table.slug)
      .where(isNotNull(table.organizationId)),
    p
      .index("mcp_connectors_org_curated_idx")
      .on(table.organizationId, table.isCurated),
    ...mcpConnectorPolicies(),
  ],
);

export const mcpOAuthClients = p.pgTable(
  "mcp_oauth_clients",
  {
    id: pUuid<"mcpOAuthClient">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectorId: safeUuid<"mcpConnector">("connector_id")
      .notNull()
      .references(() => mcpConnectors.id, { onDelete: "cascade" }),
    authorizationServerUrl: p.text("authorization_server_url").notNull(),
    clientId: p.text("client_id").notNull(),
    clientSecretEncrypted: bytea("client_secret_encrypted"),
    clientSecretIv: bytea("client_secret_iv"),
    registrationResponse: jsonb("registration_response")
      .$type<McpOAuthRegistrationResponse>()
      .notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("mcp_oauth_clients_org_connector_as_uidx")
      .on(
        table.organizationId,
        table.connectorId,
        table.authorizationServerUrl,
      ),
    p
      .index("mcp_oauth_clients_org_connector_idx")
      .on(table.organizationId, table.connectorId),
    p.index("mcp_oauth_clients_connector_idx").on(table.connectorId),
    ...mcpOAuthClientPolicies(),
  ],
);

export const mcpUserConnections = p.pgTable(
  "mcp_user_connections",
  {
    id: pUuid<"mcpUserConnection">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectorId: safeUuid<"mcpConnector">("connector_id")
      .notNull()
      .references(() => mcpConnectors.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessTokenEncrypted: bytea("access_token_encrypted"),
    accessTokenIv: bytea("access_token_iv"),
    refreshTokenEncrypted: bytea("refresh_token_encrypted"),
    refreshTokenIv: bytea("refresh_token_iv"),
    staticTokenEncrypted: bytea("static_token_encrypted"),
    staticTokenIv: bytea("static_token_iv"),
    tokenType: p.varchar("token_type", { length: 40 }),
    scope: p.text(),
    resourceUrl: p.text("resource_url"),
    authorizationServerUrl: p.text("authorization_server_url"),
    expiresAt: p.timestamp("expires_at"),
    status: p
      .text("status", { enum: MCP_CONNECTION_STATUSES })
      .notNull()
      .$type<McpConnectionStatus>(),
    enabled: p.boolean().notNull().default(true),
    lastUsedAt: p.timestamp("last_used_at"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("mcp_user_connections_org_connector_user_uidx")
      .on(table.organizationId, table.connectorId, table.userId),
    p
      .index("mcp_user_connections_user_status_idx")
      .on(table.userId, table.status),
    p
      .index("mcp_user_connections_org_user_status_idx")
      .on(table.organizationId, table.userId, table.status),
    p
      .index("mcp_user_connections_org_user_enabled_status_idx")
      .on(table.organizationId, table.userId, table.enabled, table.status),
    p.index("mcp_user_connections_connector_idx").on(table.connectorId),
    ...mcpUserConnectionPolicies(),
  ],
);

export const mcpOAuthState = p.pgTable(
  "mcp_oauth_state",
  {
    state: p.varchar({ length: 128 }).primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    connectorId: safeUuid<"mcpConnector">("connector_id")
      .notNull()
      .references(() => mcpConnectors.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    codeVerifier: p.text("code_verifier").notNull(),
    redirectUri: p.text("redirect_uri").notNull(),
    resourceUrl: p.text("resource_url").notNull(),
    authorizationServerUrl: p.text("authorization_server_url").notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("mcp_oauth_state_created_idx").on(table.createdAt),
    p
      .index("mcp_oauth_state_org_user_idx")
      .on(table.organizationId, table.userId),
    ...mcpOAuthStatePolicies(),
  ],
);

// -- User Files (private user-owned uploads) --

export const userFiles = p.pgTable(
  "user_files",
  {
    id: pUuid<"userFile">().primaryKey(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fileName: p.varchar("file_name", { length: 512 }).notNull(),
    mimeType: p.varchar("mime_type", { length: 255 }).notNull(),
    sizeBytes: p.integer("size_bytes").notNull(),
    sha256Hex: p.varchar("sha256_hex", { length: 64 }).notNull(),
    s3Key: p.text("s3_key").notNull(),
    threadId: safeUuid<"chatThread">("thread_id")
      .notNull()
      .references(() => chatThreads.id, {
        onDelete: "restrict",
      }),
    scanWarnings: p.text("scan_warnings").array(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p.index("user_files_user_created_idx").on(table.userId, table.createdAt),
    p
      .index("user_files_thread_created_idx")
      .on(table.threadId, table.createdAt),
    p.index("user_files_user_hash_idx").on(table.userId, table.sha256Hex),
    p.index("user_files_s3_key_idx").on(table.s3Key),
    ...userPolicies(),
  ],
);

// -- Workspace Views --

export const workspaceViews = p.pgTable(
  "workspace_views",
  {
    id: pUuid<"workspaceView">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 256 }).notNull(),
    layout: jsonb().$type<ViewLayout>().notNull(),
    position: p.integer().notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("workspace_views_workspace_position_idx")
      .on(table.workspaceId, table.position),
    ...wsPolicies(),
  ],
);

// -- Prompt Shortcuts --

export const PROMPT_SHORTCUT_SCOPES = ["team", "private"] as const;
export type PromptShortcutScope = (typeof PROMPT_SHORTCUT_SCOPES)[number];

export const RESERVED_SHORTCUT_COMMANDS = ["model", "new"] as const;
export const SHORTCUT_COMMAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,48}$/;

export const promptShortcuts = p.pgTable(
  "prompt_shortcuts",
  {
    id: pUuid<"promptShortcut">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scope: p.text("scope", { enum: PROMPT_SHORTCUT_SCOPES }).notNull(),
    name: p.varchar({ length: 256 }).notNull(),
    description: p.text(),
    command: p.varchar({ length: 50 }).notNull(),
    prompt: p.text().notNull(),
    isDefault: p.boolean("is_default").notNull().default(false),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Team commands: unique per org
    p
      .uniqueIndex("prompt_shortcuts_org_team_command_uidx")
      .on(table.organizationId, table.command)
      .where(sql`scope = 'team'`),
    // Private commands: unique per user
    p
      .uniqueIndex("prompt_shortcuts_user_private_command_uidx")
      .on(table.userId, table.command)
      .where(sql`scope = 'private'`),
    p
      .index("prompt_shortcuts_org_scope_idx")
      .on(table.organizationId, table.scope),
    p.index("prompt_shortcuts_user_idx").on(table.userId),
    ...promptShortcutPolicies(),
  ],
);

// -- Relations --

export const relations = defineRelations(
  {
    user,
    contacts,
    contactRelationships,
    workspaces,
    workspaceMembers,
    workspaceContacts,
    auditLogs,
    schedulerJobs,
    schedulerJobRuns,
    infoSoudTrackedCases,
    properties,
    propertyDependencies,
    entities,
    taskAssignees,
    entityLinks,
    entityVersions,
    entityVersionAiSummaries,
    desktopEditSessions,
    fields,
    justifications,
    templates,
    templateVersions,
    timeEntries,
    billingCodes,
    rateTables,
    rateEntries,
    expenses,
    invoices,
    matterCounters,
    documentCounters,
    organizationSettings,
    anonymizationBlacklistEntries,
    clauseCategories,
    clauses,
    clauseVariants,
    clauseVersions,
    templateCategories,
    templateClauses,
    templateFills,
    searchDocuments,
    extractedContent,
    caseLawSources,
    caseLawDecisions,
    caseLawCitations,
    caseLawPolarityRules,
    caseLawCourtWeights,
    caseLawFtsConfigs,
    caseLawMatterLinks,
    caseLawSearchDocuments,
    caseLawIngestionEvents,
    caseLawIngestionFailures,
    chatThreads,
    chatMessages,
    mcpConnectors,
    mcpOAuthClients,
    mcpUserConnections,
    mcpOAuthState,
    userFiles,
    workspaceViews,
    promptShortcuts,
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
    schedulerJobs: {
      runs: r.many.schedulerJobRuns({
        from: r.schedulerJobs.id,
        to: r.schedulerJobRuns.jobId,
      }),
    },
    schedulerJobRuns: {
      job: r.one.schedulerJobs({
        from: r.schedulerJobRuns.jobId,
        to: r.schedulerJobs.id,
      }),
    },
    infoSoudTrackedCases: {
      workspace: r.one.workspaces({
        from: r.infoSoudTrackedCases.workspaceId,
        to: r.workspaces.id,
      }),
      createdByUser: r.one.user({
        from: r.infoSoudTrackedCases.createdBy,
        to: r.user.id,
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
    userFiles: {
      user: r.one.user({
        from: r.userFiles.userId,
        to: r.user.id,
      }),
      thread: r.one.chatThreads({
        from: r.userFiles.threadId,
        to: r.chatThreads.id,
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
      members: r.many.workspaceMembers({
        from: r.workspaces.id,
        to: r.workspaceMembers.workspaceId,
      }),
      views: r.many.workspaceViews({
        from: r.workspaces.id,
        to: r.workspaceViews.workspaceId,
      }),
    },
    workspaceMembers: {
      workspace: r.one.workspaces({
        from: r.workspaceMembers.workspaceId,
        to: r.workspaces.id,
      }),
      user: r.one.user({
        from: r.workspaceMembers.userId,
        to: r.user.id,
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
      desktopEditSessions: r.many.desktopEditSessions({
        from: r.entities.id,
        to: r.desktopEditSessions.entityId,
      }),
      currentVersion: r.one.entityVersions({
        from: r.entities.currentVersionId,
        to: r.entityVersions.id,
      }),
      createdByUser: r.one.user({
        from: r.entities.createdBy,
        to: r.user.id,
      }),
      lastEditedByUser: r.one.user({
        from: r.entities.lastEditedBy,
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
      assignees: r.many.taskAssignees({
        from: r.entities.id,
        to: r.taskAssignees.entityId,
      }),
      linksAsSource: r.many.entityLinks({
        from: r.entities.id,
        to: r.entityLinks.sourceEntityId,
        alias: "entityLinkSource",
      }),
      linksAsTarget: r.many.entityLinks({
        from: r.entities.id,
        to: r.entityLinks.targetEntityId,
        alias: "entityLinkTarget",
      }),
    },
    taskAssignees: {
      entity: r.one.entities({
        from: r.taskAssignees.entityId,
        to: r.entities.id,
      }),
      user: r.one.user({
        from: r.taskAssignees.userId,
        to: r.user.id,
      }),
    },
    entityLinks: {
      workspace: r.one.workspaces({
        from: r.entityLinks.workspaceId,
        to: r.workspaces.id,
      }),
      sourceEntity: r.one.entities({
        from: r.entityLinks.sourceEntityId,
        to: r.entities.id,
        alias: "entityLinkSource",
      }),
      targetEntity: r.one.entities({
        from: r.entityLinks.targetEntityId,
        to: r.entities.id,
        alias: "entityLinkTarget",
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
      aiSummary: r.one.entityVersionAiSummaries({
        from: r.entityVersions.id,
        to: r.entityVersionAiSummaries.entityVersionId,
      }),
    },
    entityVersionAiSummaries: {
      entity: r.one.entities({
        from: r.entityVersionAiSummaries.entityId,
        to: r.entities.id,
      }),
      entityVersion: r.one.entityVersions({
        from: r.entityVersionAiSummaries.entityVersionId,
        to: r.entityVersions.id,
      }),
      workspace: r.one.workspaces({
        from: r.entityVersionAiSummaries.workspaceId,
        to: r.workspaces.id,
      }),
    },
    desktopEditSessions: {
      workspace: r.one.workspaces({
        from: r.desktopEditSessions.workspaceId,
        to: r.workspaces.id,
      }),
      entity: r.one.entities({
        from: r.desktopEditSessions.entityId,
        to: r.entities.id,
      }),
      property: r.one.properties({
        from: r.desktopEditSessions.propertyId,
        to: r.properties.id,
      }),
      baseVersion: r.one.entityVersions({
        from: r.desktopEditSessions.baseVersionId,
        to: r.entityVersions.id,
        alias: "desktopEditSessionBaseVersion",
      }),
      finalizedVersion: r.one.entityVersions({
        from: r.desktopEditSessions.finalizedVersionId,
        to: r.entityVersions.id,
        alias: "desktopEditSessionFinalizedVersion",
      }),
      createdByUser: r.one.user({
        from: r.desktopEditSessions.createdBy,
        to: r.user.id,
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
    documentCounters: {},
    organizationSettings: {},
    anonymizationBlacklistEntries: {},
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
    caseLawSources: {},
    caseLawDecisions: {
      source: r.one.caseLawSources({
        from: r.caseLawDecisions.sourceId,
        to: r.caseLawSources.id,
      }),
      citationsFrom: r.many.caseLawCitations({
        from: r.caseLawDecisions.id,
        to: r.caseLawCitations.citingDecisionId,
      }),
      citationsTo: r.many.caseLawCitations({
        from: r.caseLawDecisions.id,
        to: r.caseLawCitations.citedDecisionId,
      }),
      searchDocument: r.one.caseLawSearchDocuments({
        from: r.caseLawDecisions.id,
        to: r.caseLawSearchDocuments.decisionId,
      }),
    },
    caseLawCitations: {
      citingDecision: r.one.caseLawDecisions({
        from: r.caseLawCitations.citingDecisionId,
        to: r.caseLawDecisions.id,
      }),
      citedDecision: r.one.caseLawDecisions({
        from: r.caseLawCitations.citedDecisionId,
        to: r.caseLawDecisions.id,
      }),
      polarityRule: r.one.caseLawPolarityRules({
        from: r.caseLawCitations.polarityRuleId,
        to: r.caseLawPolarityRules.id,
      }),
    },
    caseLawPolarityRules: {},
    caseLawCourtWeights: {},
    caseLawFtsConfigs: {},
    caseLawMatterLinks: {
      decision: r.one.caseLawDecisions({
        from: r.caseLawMatterLinks.decisionId,
        to: r.caseLawDecisions.id,
      }),
      workspace: r.one.workspaces({
        from: r.caseLawMatterLinks.workspaceId,
        to: r.workspaces.id,
      }),
      linkedByUser: r.one.user({
        from: r.caseLawMatterLinks.linkedBy,
        to: r.user.id,
      }),
    },
    caseLawSearchDocuments: {
      decision: r.one.caseLawDecisions({
        from: r.caseLawSearchDocuments.decisionId,
        to: r.caseLawDecisions.id,
      }),
    },
    caseLawIngestionEvents: {
      source: r.one.caseLawSources({
        from: r.caseLawIngestionEvents.sourceId,
        to: r.caseLawSources.id,
      }),
    },
    caseLawIngestionFailures: {
      source: r.one.caseLawSources({
        from: r.caseLawIngestionFailures.sourceId,
        to: r.caseLawSources.id,
      }),
    },
    chatThreads: {
      workspace: r.one.workspaces({
        from: r.chatThreads.workspaceId,
        to: r.workspaces.id,
      }),
      messages: r.many.chatMessages({
        from: r.chatThreads.id,
        to: r.chatMessages.threadId,
      }),
      userFiles: r.many.userFiles({
        from: r.chatThreads.id,
        to: r.userFiles.threadId,
      }),
    },
    chatMessages: {
      thread: r.one.chatThreads({
        from: r.chatMessages.threadId,
        to: r.chatThreads.id,
      }),
      workspace: r.one.workspaces({
        from: r.chatMessages.workspaceId,
        to: r.workspaces.id,
      }),
    },
    mcpConnectors: {
      oauthClients: r.many.mcpOAuthClients({
        from: r.mcpConnectors.id,
        to: r.mcpOAuthClients.connectorId,
      }),
      userConnections: r.many.mcpUserConnections({
        from: r.mcpConnectors.id,
        to: r.mcpUserConnections.connectorId,
      }),
      oauthStates: r.many.mcpOAuthState({
        from: r.mcpConnectors.id,
        to: r.mcpOAuthState.connectorId,
      }),
    },
    mcpOAuthClients: {
      connector: r.one.mcpConnectors({
        from: r.mcpOAuthClients.connectorId,
        to: r.mcpConnectors.id,
      }),
    },
    mcpUserConnections: {
      connector: r.one.mcpConnectors({
        from: r.mcpUserConnections.connectorId,
        to: r.mcpConnectors.id,
      }),
      user: r.one.user({
        from: r.mcpUserConnections.userId,
        to: r.user.id,
      }),
    },
    mcpOAuthState: {
      connector: r.one.mcpConnectors({
        from: r.mcpOAuthState.connectorId,
        to: r.mcpConnectors.id,
      }),
      user: r.one.user({
        from: r.mcpOAuthState.userId,
        to: r.user.id,
      }),
    },
    workspaceViews: {
      workspace: r.one.workspaces({
        from: r.workspaceViews.workspaceId,
        to: r.workspaces.id,
      }),
    },
    promptShortcuts: {
      user: r.one.user({
        from: r.promptShortcuts.userId,
        to: r.user.id,
      }),
    },
  }),
);
