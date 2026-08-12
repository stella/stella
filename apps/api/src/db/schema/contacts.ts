import { CONTACT_TYPES, WORKSPACE_CONTACT_ROLES } from "@stll/api-contract";

import {
  centsColumn,
  isNotNull,
  jsonb,
  orgPolicies,
  organization,
  organizationCheck,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  stella,
  user,
  workspaceIdCheck,
  wsOrganizationPolicies,
  wsPolicies,
  timestamptz,
} from "./common";
import type {
  BankAccount,
  BillingAddress,
  ContactAddress,
  ContactEmail,
  ContactPersistedMetadata,
  ContactPhone,
  SchedulerPayload,
  SchedulerSchedule,
} from "./common";

export const contacts = p.pgTable(
  "contacts",
  {
    id: pUuid<"contact">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    type: p.text({ enum: CONTACT_TYPES }).notNull(),

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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
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
    p
      .index("contacts_display_name_arabic_norm_trgm_idx")
      .using("gin", sql`arabic_normalize(${table.displayName}) gin_trgm_ops`),
    p
      .index("contacts_first_name_arabic_norm_trgm_idx")
      .using("gin", sql`arabic_normalize(${table.firstName}) gin_trgm_ops`),
    p
      .index("contacts_last_name_arabic_norm_trgm_idx")
      .using("gin", sql`arabic_normalize(${table.lastName}) gin_trgm_ops`),
    p
      .index("contacts_organization_name_arabic_norm_trgm_idx")
      .using(
        "gin",
        sql`arabic_normalize(${table.organizationName}) gin_trgm_ops`,
      ),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
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
    // Optional per-matter lead. Decouples the lead from the client's
    // responsible attorney so co-counsels can split matters under a
    // shared client. ON DELETE SET NULL: removing the user must not
    // cascade-delete the matter.
    leadUserId: p
      .text("lead_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    billingReference: p.varchar("billing_reference", {
      length: 128,
    }),
    color: p.varchar({ length: 32 }),
    status: p
      .text({ enum: ["active", "deleting", "archived"] })
      .notNull()
      .default("active"),
    lastActivityAt: timestamptz("last_activity_at").notNull().defaultNow(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("workspaces_organization_id_idx").on(table.organizationId),
    p
      .unique("workspaces_org_reference_uidx")
      .on(table.organizationId, table.reference),
    // Composite tenant key for child tables that carry both workspace and
    // organization IDs. This makes a cross-tenant pair impossible even on
    // root/background write paths that bypass RLS.
    p.unique("workspaces_id_org_unq").on(table.id, table.organizationId),
    p
      .index("workspaces_org_client_id_idx")
      .on(table.organizationId, table.clientId)
      .where(isNotNull(table.clientId)),
    p
      .index("workspaces_org_activity_id_non_deleting_idx")
      .on(table.organizationId, table.lastActivityAt.desc(), table.id.desc())
      .where(sql`${table.status} <> 'deleting'`),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
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
        enum: WORKSPACE_CONTACT_ROLES,
      })
      .notNull(),
    isPrimary: p.boolean("is_primary").notNull().default(false),
    notes: p.text(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
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
    ...wsOrganizationPolicies("workspace_contacts"),
  ],
);

// -- Audit Logs --

export const AUDIT_PERFORMER_TYPES = ["user", "agent", "service"] as const;
export const AUDIT_TRIGGER_TYPES = [
  "direct",
  "user_dispatch",
  "agent_delegation",
  "schedule",
  "webhook",
  "credential",
  "system",
] as const;
export const AUDIT_APPROVAL_STATUSES = [
  "not_required",
  "pending",
  "approved",
  "rejected",
] as const;
export const AUDIT_ACTIVITY_CATEGORIES = [
  "documents",
  "tasks",
  "matter",
  "team",
  "court",
  "automation",
  "other",
] as const;

const AUDIT_PERFORMER_TYPE_SQL_VALUES = AUDIT_PERFORMER_TYPES.map(
  (performerType) => sql.raw(`'${performerType}'`),
);

const AUDIT_TRIGGER_TYPE_SQL_VALUES = AUDIT_TRIGGER_TYPES.map((triggerType) =>
  sql.raw(`'${triggerType}'`),
);

const AUDIT_APPROVAL_STATUS_SQL_VALUES = AUDIT_APPROVAL_STATUSES.map(
  (approvalStatus) => sql.raw(`'${approvalStatus}'`),
);

const AUDIT_ACTIVITY_CATEGORY_SQL_VALUES = AUDIT_ACTIVITY_CATEGORIES.map(
  (activityCategory) => sql.raw(`'${activityCategory}'`),
);

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
    performerType: p
      .text("performer_type", { enum: AUDIT_PERFORMER_TYPES })
      .notNull()
      .default("user"),
    performerId: p.text("performer_id"),
    performerName: p.text("performer_name"),
    triggerType: p
      .text("trigger_type", { enum: AUDIT_TRIGGER_TYPES })
      .notNull()
      .default("direct"),
    triggerUserId: p.text("trigger_user_id"),
    triggerSource: p.text("trigger_source"),
    triggerSourceId: p.text("trigger_source_id"),
    runId: p.text("run_id"),
    groupId: p.uuid("group_id"),
    approvalStatus: p
      .text("approval_status", { enum: AUDIT_APPROVAL_STATUSES })
      .notNull()
      .default("not_required"),
    approvedByUserId: p.text("approved_by_user_id"),
    activityCategory: p.text("activity_category", {
      enum: AUDIT_ACTIVITY_CATEGORIES,
    }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "audit_logs_performer_type_check",
      sql`${table.performerType} in (${sql.join(AUDIT_PERFORMER_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "audit_logs_trigger_type_check",
      sql`${table.triggerType} in (${sql.join(AUDIT_TRIGGER_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "audit_logs_approval_status_check",
      sql`${table.approvalStatus} in (${sql.join(AUDIT_APPROVAL_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "audit_logs_activity_category_check",
      sql`${table.activityCategory} is null or ${table.activityCategory} in (${sql.join(AUDIT_ACTIVITY_CATEGORY_SQL_VALUES, sql`, `)})`,
    ),
    p
      .index("audit_logs_org_created_id_idx")
      .on(table.organizationId, table.createdAt, table.id),
    p
      .index("audit_logs_org_workspace_created_id_idx")
      .on(table.organizationId, table.workspaceId, table.createdAt, table.id),
    p
      .index("audit_logs_org_workspace_category_created_id_idx")
      .on(
        table.organizationId,
        table.workspaceId,
        table.activityCategory,
        table.createdAt,
        table.id,
      ),
    p
      .index("audit_logs_org_workspace_performer_created_id_idx")
      .on(
        table.organizationId,
        table.workspaceId,
        table.performerType,
        table.createdAt,
        table.id,
      ),
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
    // Audit logs are append-only: SELECT + INSERT above are the only
    // operations `stella` ever needs. UPDATE/DELETE are denied today
    // purely by Postgres' default-deny (no matching policy). These
    // RESTRICTIVE `false` policies make that immutability explicit and
    // durable — a RESTRICTIVE policy is AND-ed with every permissive
    // one, so a future migration adding a permissive UPDATE/DELETE
    // policy cannot silently unlock mutation of the audit trail.
    p.pgPolicy("audit_logs_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("audit_logs_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
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
    nextRunAt: timestamptz("next_run_at").notNull(),
    lastRunAt: timestamptz("last_run_at"),
    lastSuccessAt: timestamptz("last_success_at"),
    lastFailureAt: timestamptz("last_failure_at"),
    lastError: p.text("last_error"),
    lockedAt: timestamptz("locked_at"),
    lockedUntil: timestamptz("locked_until"),
    lockedBy: p.varchar("locked_by", { length: 128 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
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
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
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
    lastSyncAttemptAt: timestamptz("last_sync_attempt_at"),
    lastSyncedAt: timestamptz("last_synced_at"),
    lastSyncError: p.text("last_sync_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
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
