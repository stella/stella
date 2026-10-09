import {
  INVOICE_LINE_SOURCES,
  INVOICE_STATUS,
  INVOICE_STATUSES,
  NUMBER_SERIES_DOCUMENT_TYPES,
  TIME_ENTRY_SUGGESTION_STATUSES,
  TIME_ENTRY_ACTIVITY_GROUP,
  TIME_ENTRY_ACTIVITY_GROUPS,
  type InvoiceStatus,
} from "@stll/api-contract";
import type { DesktopTimeEntryBatchResponse } from "@stll/api-contract/desktop-time-entries";
import type { TimeEntrySuggestionEvidence } from "@stll/api-contract/time-entry-types";
import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import { VAT_TREATMENTS } from "@stll/invoicing";
import { ORGANIZATION_MANAGEMENT_ROLES } from "@stll/permissions";

import { entityFeaturePolicies } from "@/api/db/entity-feature-policies";
import { timeEntryPolicies } from "@/api/db/rls";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import type { SafeId } from "@/api/lib/branded-types";

import { BILLING_ARRANGEMENT_MODES } from "./billing-arrangements";
import {
  EXPENSE_CATEGORIES,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
  centsColumn,
  member,
  organization,
  orgPolicies,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  stella,
  unsafeCents,
  user,
  userOrganizationPolicies,
  wsOrganizationPolicies,
  wsOrganizationUserPolicies,
  wsPolicies,
  timestamptz,
} from "./common";
import { workspaces } from "./contacts";
import { entities } from "./entities";

export const ACTIVE_TIMER_INDEX_NAME =
  "time_entries_one_active_timer_per_user_idx";

const DAILY_TARGET_ADMIN_ROLES = ORGANIZATION_MANAGEMENT_ROLES.map((role) =>
  sql.raw(`'${role}'`),
);
const DAILY_TARGET_ACCESS = sql`(
  "time_daily_targets"."organization_id" = (SELECT current_setting('app.organization_id', true))
  AND (
    "time_daily_targets"."user_id" = (SELECT current_setting('app.user_id', true))
    OR EXISTS (
      SELECT 1 FROM ${member}
      WHERE ${member.organizationId} = (SELECT current_setting('app.organization_id', true))
        AND ${member.userId} = (SELECT current_setting('app.user_id', true))
        AND ${member.role} IN (${sql.join(DAILY_TARGET_ADMIN_ROLES, sql`, `)})
    )
  )
)`;

export const timeDailyTargets = p.pgTable(
  "time_daily_targets",
  {
    organizationId: safeOrganizationId("organization_id").notNull(),
    userId: p.text("user_id").notNull(),
    minutes: p.integer("minutes"),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    p.primaryKey({ columns: [table.organizationId, table.userId] }),
    p
      .foreignKey({
        columns: [table.organizationId, table.userId],
        foreignColumns: [member.organizationId, member.userId],
        name: "time_daily_targets_member_fk",
      })
      .onDelete("cascade"),
    p.check(
      "time_daily_targets_minutes_check",
      sql`${table.minutes} IS NULL OR (${table.minutes} > 0 AND ${table.minutes} <= 1440)`,
    ),
    p.pgPolicy("member_target_access", {
      for: "all",
      to: stella,
      using: DAILY_TARGET_ACCESS,
      withCheck: DAILY_TARGET_ACCESS,
    }),
  ],
);

const TIME_ENTRY_SUGGESTION_STATUS_SQL_VALUES =
  TIME_ENTRY_SUGGESTION_STATUSES.map((status) => sql.raw(`'${status}'`));

const TIME_ENTRY_APPROVAL_PROVENANCE_STATUSES = [
  "approved",
  "billed",
  "written_off",
] as const satisfies readonly (typeof TIME_ENTRY_STATUSES)[number][];
const INTERNAL_TIME_ENTRY_STATUSES = [
  "draft",
  "approved",
] as const satisfies readonly (typeof TIME_ENTRY_STATUSES)[number][];

export const INVOICE_ATTACHMENT = {
  CHARGED: "charged",
  COVERED: "covered",
} as const;
export const INVOICE_BILLING_PURPOSE = {
  ORDINARY: "ordinary",
  FLAT_FEE: "flat_fee",
} as const;

const INVOICE_ATTACHMENT_VALUES = [
  INVOICE_ATTACHMENT.CHARGED,
  INVOICE_ATTACHMENT.COVERED,
] as const;
const INVOICE_BILLING_PURPOSE_VALUES = [
  INVOICE_BILLING_PURPOSE.ORDINARY,
  INVOICE_BILLING_PURPOSE.FLAT_FEE,
] as const;

export const timeEntries = p.pgTable(
  "time_entries",
  {
    id: pUuid<"timeEntry">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    activityGroup: p
      .text("activity_group", { enum: TIME_ENTRY_ACTIVITY_GROUPS })
      .notNull()
      .default(TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      { onDelete: "cascade" },
    ),
    userId: p
      .text("user_id")
      .references(() => user.id, { onDelete: "set null" }),
    approverUserId: p
      .text("approver_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    // Retain historical actor identifiers after account records are removed.
    approvedByUserId: p.text("approved_by_user_id").$type<SafeId<"user">>(),
    approvedAt: timestamptz("approved_at"),
    returnedByUserId: p.text("returned_by_user_id").$type<SafeId<"user">>(),
    returnedAt: timestamptz("returned_at"),
    returnComment: p.text("return_comment"),
    // A workspace is the legal matter. This optional foreign key records only
    // the document, folder, task, or other work item that provided context.
    workItemId: safeUuid<"entity">("work_item_id"),
    dateWorked: p.date("date_worked").notNull(),
    timezoneId: p.text("timezone_id").notNull(),
    durationMinutes: p.integer("duration_minutes").notNull(),
    billedMinutes: p.integer("billed_minutes").notNull(),
    rateAtEntry: centsColumn("rate_at_entry").notNull(),
    currency: p.varchar({ length: 3 }).notNull(),
    narrative: p.text().notNull(),
    narrativeLanguage: p.varchar("narrative_language", { length: 64 }),
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
    invoiceAttachment: p
      .text("invoice_attachment", {
        enum: INVOICE_ATTACHMENT_VALUES,
      })
      .notNull()
      .default(INVOICE_ATTACHMENT.CHARGED),
    splitGroupId: safeUuid<"timeEntry">("split_group_id"),
    timerStartedAt: timestamptz("timer_started_at"),
    timerStoppedAt: timestamptz("timer_stopped_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").defaultNow(),
  },
  (table) => [
    ...entityFeaturePolicies(
      table,
      new Map([[table.workItemId, { target: "entities", kind: "context" }]]),
    ),
    p.check(
      "time_entries_invoice_attachment_check",
      sql`${table.invoiceAttachment} IN (${sql.join(
        INVOICE_ATTACHMENT_VALUES.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    ),
    p
      .foreignKey({
        columns: [table.workItemId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "time_entries_work_item_workspace_fk",
      })
      .onDelete("restrict"),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "time_entries_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .index("time_entries_ws_user_date_idx")
      .on(table.workspaceId, table.userId, table.dateWorked),
    p
      .index("time_entries_org_user_date_id_idx")
      .on(table.organizationId, table.userId, table.dateWorked, table.id),
    p
      .index("time_entries_org_status_date_id_idx")
      .on(table.organizationId, table.status, table.dateWorked, table.id),
    p
      .index("time_entries_ws_work_item_status_idx")
      .on(table.workspaceId, table.workItemId, table.status),
    p.index("time_entries_ws_status_idx").on(table.workspaceId, table.status),
    p.index("time_entries_invoice_idx").on(table.invoiceId),
    p
      .index("time_entries_approval_queue_idx")
      .on(
        table.organizationId,
        table.approverUserId,
        table.status,
        table.dateWorked,
        table.id,
      )
      .where(sql`${table.status} = 'draft'`),
    p
      .uniqueIndex(ACTIVE_TIMER_INDEX_NAME)
      .on(table.userId)
      .where(sql`${table.timerStartedAt} IS NOT NULL`),
    p.check(
      "time_entries_duration_or_timer_check",
      sql`${table.durationMinutes} > 0 OR ${table.timerStartedAt} IS NOT NULL`,
    ),
    p.check(
      "time_entries_billed_minutes_check",
      sql`${table.billedMinutes} >= 0`,
    ),
    p.check(
      "time_entries_approval_provenance_check",
      sql`(${table.approvedByUserId} IS NULL AND ${table.approvedAt} IS NULL) OR (${table.approvedByUserId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL AND ${table.status} IN (${sql.join(
        TIME_ENTRY_APPROVAL_PROVENANCE_STATUSES.map((status) =>
          sql.raw(`'${status}'`),
        ),
        sql`, `,
      )}))`,
    ),
    p.check(
      "time_entries_return_metadata_check",
      sql`(${table.returnedByUserId} IS NULL AND ${table.returnedAt} IS NULL AND ${table.returnComment} IS NULL) OR (${table.returnedByUserId} IS NOT NULL AND ${table.returnedAt} IS NOT NULL AND ${table.returnComment} IS NOT NULL AND char_length(btrim(${table.returnComment})) BETWEEN 1 AND 2000 AND char_length(${table.returnComment}) <= 2000)`,
    ),
    p.check(
      "time_entries_activity_group_check",
      sql`${table.activityGroup} IN (${sql.join(
        TIME_ENTRY_ACTIVITY_GROUPS.map((group) => sql.raw(`'${group}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "time_entries_client_workspace_check",
      sql`${table.activityGroup} <> 'client' OR ${table.workspaceId} IS NOT NULL`,
    ),
    p.check(
      "time_entries_internal_shape_check",
      sql`${table.activityGroup} <> 'internal' OR (
      ${table.workspaceId} IS NULL AND ${table.billable} = false AND ${table.noCharge} = false
      AND ${table.billedMinutes} = 0 AND ${table.rateAtEntry} = 0 AND ${table.currency} = '${sql.raw(UNPRICED_TIME_ENTRY_CURRENCY)}'
      AND ${table.invoiceId} IS NULL AND ${table.workItemId} IS NULL
      AND ${table.taskCode} IS NULL AND ${table.activityCode} IS NULL AND ${table.invoiceNarrative} IS NULL
      AND ${table.status} IN (${sql.join(
        INTERNAL_TIME_ENTRY_STATUSES.map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )}))`,
    ),
    ...timeEntryPolicies(),
  ],
);

export const TIME_TIMER_STATES = ["running", "paused"] as const;
export const RUNNING_TIME_TIMER_INDEX_NAME =
  "time_timers_one_running_owner_idx";
const TIME_TIMER_STATE_SQL_VALUES = TIME_TIMER_STATES.map((state) =>
  sql.raw(`'${state}'`),
);

const TIME_TIMER_CURRENT_MEMBER_CHECK = sql`EXISTS (
  SELECT 1 FROM ${member}
  WHERE ${member.organizationId} = "time_timers"."organization_id"
    AND ${member.userId} = "time_timers"."user_id"
)`;

const TIME_TIMER_ADMIN_ROLE_SQL_VALUES = ORGANIZATION_MANAGEMENT_ROLES.map(
  (role) => sql.raw(`'${role}'`),
);

const timerOrganizationAdminCheck = (
  tableName:
    | "time_timers"
    | "time_timer_confirmations"
    | "time_entry_timer_states",
) => sql`(
  ${sql.identifier(tableName)}."organization_id" = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM ${member}
    WHERE ${member.organizationId} = (SELECT current_setting('app.organization_id', true))
      AND ${member.userId} = (SELECT current_setting('app.user_id', true))
      AND ${member.role} IN (${sql.join(TIME_TIMER_ADMIN_ROLE_SQL_VALUES, sql`, `)})
  )
)`;

const TIME_TIMER_ADMIN_CHECK = sql`(
  ${timerOrganizationAdminCheck("time_timers")} AND "time_timers"."state" = 'running'
)`;
const TIME_TIMER_ADMIN_DELETE_CHECK = sql`(
  ${TIME_TIMER_ADMIN_CHECK}
  AND EXISTS (
    SELECT 1 FROM "time_timer_confirmations"
    WHERE "time_timer_confirmations"."timer_id" = "time_timers"."id"
      AND "time_timer_confirmations"."organization_id" = "time_timers"."organization_id"
      AND "time_timer_confirmations"."user_id" = "time_timers"."user_id"
      AND "time_timer_confirmations"."time_entry_id" IS NOT NULL
  )
)`;
const TIME_TIMER_CONFIRMATION_ADMIN_CHECK = timerOrganizationAdminCheck(
  "time_timer_confirmations",
);
const TIME_TIMER_CONFIRMATION_ADMIN_INSERT_CHECK = sql`(
  ${TIME_TIMER_CONFIRMATION_ADMIN_CHECK}
  AND EXISTS (
    SELECT 1 FROM ${member}
    WHERE ${member.organizationId} = "time_timer_confirmations"."organization_id"
      AND ${member.userId} = "time_timer_confirmations"."user_id"
  )
  AND EXISTS (
    SELECT 1 FROM "time_timers"
    WHERE "time_timers"."id" = "time_timer_confirmations"."timer_id"
      AND "time_timers"."organization_id" = "time_timer_confirmations"."organization_id"
      AND "time_timers"."user_id" = "time_timer_confirmations"."user_id"
      AND "time_timers"."state" = 'running'
  )
  AND "time_timer_confirmations"."time_entry_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM ${timeEntries}
    WHERE ${timeEntries.id} = "time_timer_confirmations"."time_entry_id"
      AND ${timeEntries.organizationId} = "time_timer_confirmations"."organization_id"
      AND ${timeEntries.userId} = "time_timer_confirmations"."user_id"
  )
)`;

export const timeTimers = p.pgTable(
  "time_timers",
  {
    id: pUuid<"timeTimer">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      { onDelete: "set null" },
    ),
    description: p.text("description"),
    legacyTimeEntryId: safeUuid<"timeEntry">("legacy_time_entry_id").references(
      () => timeEntries.id,
      { onDelete: "set null" },
    ),
    state: p.text("state", { enum: TIME_TIMER_STATES }).notNull(),
    startedAt: timestamptz("started_at").notNull(),
    accumulatedSeconds: p.integer("accumulated_seconds").notNull().default(0),
    lastResumedAt: timestamptz("last_resumed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspaces.id, workspaces.organizationId],
      name: "time_timers_workspace_organization_fk",
    }),
    p
      .uniqueIndex(RUNNING_TIME_TIMER_INDEX_NAME)
      .on(table.organizationId, table.userId)
      .where(sql`${table.state} = 'running'`),
    p
      .index("time_timers_owner_id_idx")
      .on(table.organizationId, table.userId, table.id),
    p
      .index("time_timers_running_org_id_idx")
      .on(table.organizationId, table.id)
      .where(sql`${table.state} = 'running'`),
    p.index("time_timers_workspace_idx").on(table.workspaceId),
    p.index("time_timers_legacy_entry_idx").on(table.legacyTimeEntryId),
    p
      .uniqueIndex("time_timers_legacy_entry_uidx")
      .on(table.legacyTimeEntryId)
      .where(sql`${table.legacyTimeEntryId} IS NOT NULL`),
    p.check(
      "time_timers_state_check",
      sql`${table.state} IN (${sql.join(TIME_TIMER_STATE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "time_timers_accumulated_seconds_check",
      sql`${table.accumulatedSeconds} >= 0`,
    ),
    p.check(
      "time_timers_resume_state_check",
      sql`(${table.state} = 'running') = (${table.lastResumedAt} IS NOT NULL)`,
    ),
    ...userOrganizationPolicies(),
    p.pgPolicy("organization_admin_select", {
      for: "select",
      to: stella,
      using: TIME_TIMER_ADMIN_CHECK,
    }),
    p.pgPolicy("organization_admin_delete", {
      for: "delete",
      to: stella,
      using: TIME_TIMER_ADMIN_DELETE_CHECK,
    }),
    p.pgPolicy("current_member", {
      as: "restrictive",
      for: "all",
      to: stella,
      using: TIME_TIMER_CURRENT_MEMBER_CHECK,
      withCheck: TIME_TIMER_CURRENT_MEMBER_CHECK,
    }),
  ],
);

export const timeTimerConfirmations = p.pgTable(
  "time_timer_confirmations",
  {
    timerId: safeUuid<"timeTimer">("timer_id").primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    timeEntryId: safeUuid<"timeEntry">("time_entry_id").references(
      () => timeEntries.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("time_timer_confirmations_owner_idx")
      .on(table.organizationId, table.userId),
    p.index("time_timer_confirmations_entry_idx").on(table.timeEntryId),
    ...userOrganizationPolicies(),
    p.pgPolicy("organization_admin_select", {
      for: "select",
      to: stella,
      using: TIME_TIMER_CONFIRMATION_ADMIN_CHECK,
    }),
    p.pgPolicy("organization_admin_insert", {
      for: "insert",
      to: stella,
      withCheck: TIME_TIMER_CONFIRMATION_ADMIN_INSERT_CHECK,
    }),
  ],
);

export const savedTimeNarratives = p.pgTable(
  "saved_time_narratives",
  {
    id: pUuid<"savedTimeNarrative">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: p.varchar({ length: 128 }).notNull(),
    narrative: p.text().notNull(),
    narrativeLanguage: p.varchar("narrative_language", { length: 64 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("saved_time_narratives_owner_name_id_idx")
      .on(table.organizationId, table.userId, table.name, table.id),
    p.check(
      "saved_time_narratives_name_check",
      sql`length(${table.name}) between 1 and 128`,
    ),
    p.check(
      "saved_time_narratives_narrative_check",
      sql`length(${table.narrative}) between 1 and 10000`,
    ),
    ...userOrganizationPolicies(),
  ],
);

/**
 * A suggested entry the timekeeper accepted or dismissed. Suggestions are
 * recomputed from the timekeeper's own matter activity on every read; only
 * the decision persists, keyed by the cluster fingerprint for that day.
 * Evidence is snapshotted on accept so the created entry stays auditable to
 * the activity it was drawn from.
 */
export const timeEntrySuggestions = p.pgTable(
  "time_entry_suggestions",
  {
    id: pUuid<"timeEntrySuggestion">().primaryKey(),
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
    dateWorked: p.date("date_worked").notNull(),
    fingerprint: p.varchar({ length: 64 }).notNull(),
    status: p
      .text("status", { enum: TIME_ENTRY_SUGGESTION_STATUSES })
      .notNull(),
    timeEntryId: safeUuid<"timeEntry">("time_entry_id").references(
      () => timeEntries.id,
      { onDelete: "set null" },
    ),
    evidence: p.jsonb().$type<TimeEntrySuggestionEvidence[]>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "time_entry_suggestions_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("time_entry_suggestions_ws_user_fingerprint_uidx")
      .on(table.workspaceId, table.userId, table.fingerprint),
    p
      .index("time_entry_suggestions_ws_user_date_idx")
      .on(table.workspaceId, table.userId, table.dateWorked),
    p.check(
      "time_entry_suggestions_status_check",
      sql`${table.status} in (${sql.join(TIME_ENTRY_SUGGESTION_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "time_entry_suggestions_accepted_entry_check",
      sql`${table.status} <> 'accepted' OR ${table.timeEntryId} IS NOT NULL OR ${table.evidence} IS NOT NULL`,
    ),
    ...wsOrganizationUserPolicies("time_entry_suggestions"),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "billing_codes_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .index("billing_codes_ws_type_active_idx")
      .on(table.workspaceId, table.type, table.active),
    p
      .uniqueIndex("billing_codes_ws_type_code_uidx")
      .on(table.workspaceId, table.type, table.code),
    ...wsOrganizationPolicies("billing_codes", { columns: table }),
  ],
);

export const sellerProfiles = p.pgTable(
  "seller_profiles",
  {
    id: pUuid<"sellerProfile">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    legalName: p.varchar("legal_name", { length: 512 }).notNull(),
    registrationId: p.varchar("registration_id", { length: 64 }),
    vatId: p.varchar("vat_id", { length: 64 }),
    addressLine1: p.varchar("address_line_1", { length: 512 }),
    addressLine2: p.varchar("address_line_2", { length: 512 }),
    city: p.varchar({ length: 256 }),
    postalCode: p.varchar("postal_code", { length: 32 }),
    country: p.varchar({ length: 128 }),
    iban: p.varchar({ length: 34 }),
    bic: p.varchar({ length: 11 }),
    accountNumber: p.varchar("account_number", { length: 64 }),
    defaultCurrency: p.varchar("default_currency", { length: 3 }).notNull(),
    footerNotes: p.text("footer_notes"),
    isDefault: p.boolean("is_default").notNull().default(false),
    archivedAt: timestamptz("archived_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("seller_profiles_org_created_idx")
      .on(table.organizationId, table.createdAt, table.id)
      .where(sql`${table.archivedAt} IS NULL`),
    p
      .uniqueIndex("seller_profiles_org_default_uidx")
      .on(table.organizationId)
      .where(sql`${table.isDefault} AND ${table.archivedAt} IS NULL`),
    p.check(
      "seller_profiles_currency_check",
      sql`${table.defaultCurrency} ~ '^[A-Z]{3}$'`,
    ),
    p.check(
      "seller_profiles_archived_default_check",
      sql`${table.archivedAt} IS NULL OR NOT ${table.isDefault}`,
    ),
    ...orgPolicies(),
  ],
);

export { NUMBER_SERIES_DOCUMENT_TYPES };
const NUMBER_SERIES_DOCUMENT_TYPE_SQL_VALUES = NUMBER_SERIES_DOCUMENT_TYPES.map(
  (documentType) => sql.raw(`'${documentType}'`),
);

export const numberSeries = p.pgTable(
  "number_series",
  {
    id: pUuid<"numberSeries">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sellerProfileId: safeUuid<"sellerProfile">("seller_profile_id"),
    documentType: p
      .text("document_type", { enum: NUMBER_SERIES_DOCUMENT_TYPES })
      .notNull(),
    name: p.varchar({ length: 128 }).notNull(),
    pattern: p.varchar({ length: 128 }).notNull(),
    padding: p.integer().notNull(),
    isDefault: p.boolean("is_default").notNull().default(false),
    archivedAt: timestamptz("archived_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.sellerProfileId],
        foreignColumns: [sellerProfiles.id],
        name: "number_series_seller_profile_id_fk",
      })
      .onDelete("no action"),
    p
      .uniqueIndex("number_series_org_id_uidx")
      .on(table.organizationId, table.id),
    p
      .index("number_series_org_created_idx")
      .on(table.organizationId, table.createdAt, table.id)
      .where(sql`${table.archivedAt} IS NULL`),
    p
      .uniqueIndex("number_series_org_type_default_uidx")
      .on(table.organizationId, table.documentType)
      .where(
        sql`${table.isDefault} AND ${table.archivedAt} IS NULL AND ${table.sellerProfileId} IS NULL`,
      ),
    p
      .uniqueIndex("number_series_org_type_seller_default_uidx")
      .on(table.organizationId, table.documentType, table.sellerProfileId)
      .where(
        sql`${table.isDefault} AND ${table.archivedAt} IS NULL AND ${table.sellerProfileId} IS NOT NULL`,
      ),
    p.check(
      "number_series_document_type_check",
      sql`${table.documentType} IN (${sql.join(NUMBER_SERIES_DOCUMENT_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "number_series_padding_check",
      sql`${table.padding} BETWEEN 1 AND 6`,
    ),
    p.check(
      "number_series_archived_default_check",
      sql`${table.archivedAt} IS NULL OR NOT ${table.isDefault}`,
    ),
    ...orgPolicies(),
  ],
);

export const numberSeriesCounters = p.pgTable(
  "number_series_counters",
  {
    organizationId: safeOrganizationId("organization_id").notNull(),
    seriesId: safeUuid<"numberSeries">("series_id").notNull(),
    periodKey: p.varchar("period_key", { length: 128 }).notNull(),
    lastValue: p.integer("last_value").notNull(),
  },
  (table) => [
    p.primaryKey({ columns: [table.seriesId, table.periodKey] }),
    p
      .foreignKey({
        columns: [table.organizationId, table.seriesId],
        foreignColumns: [numberSeries.organizationId, numberSeries.id],
        name: "number_series_counters_series_org_fk",
      })
      .onDelete("cascade"),
    p.index("number_series_counters_org_idx").on(table.organizationId),
    p.check(
      "number_series_counters_positive_check",
      sql`${table.lastValue} > 0`,
    ),
    ...orgPolicies(),
  ],
);

export const numberSeriesAllocations = p.pgTable(
  "number_series_allocations",
  {
    organizationId: safeOrganizationId("organization_id").notNull(),
    seriesId: safeUuid<"numberSeries">("series_id").notNull(),
    documentType: p
      .text("document_type", { enum: NUMBER_SERIES_DOCUMENT_TYPES })
      .notNull(),
    number: p.varchar({ length: 64 }).notNull(),
    issuedAt: timestamptz("issued_at").notNull(),
  },
  (table) => [
    p.primaryKey({
      name: "number_series_allocations_number_pk",
      columns: [table.organizationId, table.documentType, table.number],
    }),
    p
      .foreignKey({
        columns: [table.organizationId, table.seriesId],
        foreignColumns: [numberSeries.organizationId, numberSeries.id],
        name: "number_series_allocations_series_org_fk",
      })
      .onDelete("cascade"),
    p.index("number_series_allocations_series_idx").on(table.seriesId),
    p.check(
      "number_series_allocations_document_type_check",
      sql`${table.documentType} IN (${sql.join(NUMBER_SERIES_DOCUMENT_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    ...orgPolicies(),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "rate_tables_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .index("rate_tables_ws_default_idx")
      .on(table.workspaceId, table.isDefault),
    p.index("rate_tables_ws_client_idx").on(table.workspaceId, table.clientId),
    ...wsOrganizationPolicies("rate_tables", { columns: table }),
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
    role: p.text("role", { enum: ORGANIZATION_ROLE_NAMES }),
    hourlyRate: centsColumn("hourly_rate").notNull(),
    effectiveFrom: p.date("effective_from").notNull(),
    effectiveTo: p.date("effective_to"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("rate_entries_table_user_from_idx")
      .on(table.rateTableId, table.userId, table.effectiveFrom),
    p
      .index("rate_entries_table_role_from_idx")
      .on(table.rateTableId, table.role, table.effectiveFrom),
    p.check(
      "rate_entries_exclusive_target_check",
      sql`${table.userId} IS NULL OR ${table.role} IS NULL`,
    ),
    p.check(
      "rate_entries_role_check",
      sql`${table.role} IS NULL OR ${table.role} IN (${sql.join(
        ORGANIZATION_ROLE_NAMES.map((role) => sql.raw(`'${role}'`)),
        sql`, `,
      )})`,
    ),
    p.index("rate_entries_workspace_id_idx").on(table.workspaceId),
    ...wsPolicies({ columns: table }),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").defaultNow(),
  },
  (table) => [
    ...entityFeaturePolicies(
      table,
      new Map([[table.matterId, { target: "entities", kind: "context" }]]),
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "expenses_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .index("expenses_ws_matter_status_idx")
      .on(table.workspaceId, table.matterId, table.status),
    p
      .index("expenses_ws_user_date_idx")
      .on(table.workspaceId, table.userId, table.dateIncurred),
    p.index("expenses_invoice_idx").on(table.invoiceId),
    p.check("expenses_amount_positive_check", sql`${table.amount} > 0`),
    ...wsOrganizationPolicies("expenses", {
      columns: table,
      references: new Map([
        [table.matterId, { target: "entities", kind: "context" }],
      ]),
    }),
  ],
);

export { INVOICE_STATUS, INVOICE_STATUSES };
export type { InvoiceStatus };

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
    invoiceNumber: p.varchar("invoice_number", { length: 64 }),
    documentType: p
      .text("document_type", { enum: NUMBER_SERIES_DOCUMENT_TYPES })
      .notNull()
      .default("invoice"),
    originalInvoiceId: safeUuid<"invoice">("original_invoice_id"),
    billingMode: p
      .text("billing_mode", { enum: BILLING_ARRANGEMENT_MODES })
      .notNull()
      .default("hourly"),
    flatFeeAmount: centsColumn("flat_fee_amount"),
    // Retained on revert to draft so document type and original stay frozen.
    finalizedAt: timestamptz("finalized_at"),
    reference: p.varchar({ length: 256 }),
    status: p
      .text("status", { enum: INVOICE_STATUSES })
      .notNull()
      .default("draft"),
    // The issue date.
    invoiceDate: p.date("invoice_date").notNull(),
    taxableSupplyDate: p.date("taxable_supply_date"),
    dueDate: p.date("due_date"),
    currency: p.varchar({ length: 3 }).notNull(),
    sellerProfileId: safeUuid<"sellerProfile">("seller_profile_id").references(
      () => sellerProfiles.id,
    ),
    // Buyer as it should read on the document, copied when set so a later
    // contact edit does not rewrite an invoice.
    buyerName: p.varchar("buyer_name", { length: 512 }),
    buyerRegistrationId: p.varchar("buyer_registration_id", { length: 64 }),
    buyerVatId: p.varchar("buyer_vat_id", { length: 64 }),
    buyerAddressLine1: p.varchar("buyer_address_line_1", { length: 512 }),
    buyerAddressLine2: p.varchar("buyer_address_line_2", { length: 512 }),
    buyerCity: p.varchar("buyer_city", { length: 256 }),
    buyerPostalCode: p.varchar("buyer_postal_code", { length: 32 }),
    buyerCountry: p.varchar("buyer_country", { length: 128 }),
    // Totals over the invoice lines, from `calculateDocumentTotals`
    // (`@stll/invoicing`); `totalAmount` is the gross. NULL on an invoice
    // whose total was written before invoice lines existed: reads derive the
    // amounts (`readInvoiceTotals`) and the next `recalculateInvoiceTotals`
    // stores them.
    netAmount: centsColumn("net_amount"),
    vatAmount: centsColumn("vat_amount"),
    // SAFETY: literal zero is a valid minor-unit integer default.
    totalAmount: centsColumn("total_amount").notNull().default(unsafeCents(0)),
    notes: p.text(),
    paidAt: timestamptz("paid_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "invoices_billing_mode_check",
      sql`${table.billingMode} IN (${sql.join(
        BILLING_ARRANGEMENT_MODES.map((value) => sql`${value}`),
        sql`, `,
      )}) AND ((${table.billingMode} = 'hourly' AND ${table.flatFeeAmount} IS NULL) OR (${table.billingMode} = 'flat_fee' AND ${table.flatFeeAmount} >= 0 AND ${table.flatFeeAmount} IS NOT NULL))`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "invoices_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p.unique("invoices_id_workspace_unique").on(table.id, table.workspaceId),
    p.foreignKey({
      columns: [table.originalInvoiceId, table.workspaceId],
      foreignColumns: [table.id, table.workspaceId],
      name: "invoices_original_invoice_workspace_fk",
    }),
    p
      .index("invoices_ws_original_idx")
      .on(table.workspaceId, table.originalInvoiceId),
    p.check(
      "invoices_document_type_check",
      sql`${table.documentType} in (${sql.join(NUMBER_SERIES_DOCUMENT_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "invoices_original_invoice_check",
      sql`(${table.documentType} = 'credit_note') = (${table.originalInvoiceId} IS NOT NULL) AND (${table.originalInvoiceId} IS NULL OR ${table.originalInvoiceId} <> ${table.id})`,
    ),
    p.index("invoices_ws_status_idx").on(table.workspaceId, table.status),
    p
      .uniqueIndex("invoices_ws_number_uidx")
      .on(table.workspaceId, table.invoiceNumber),
    ...wsOrganizationPolicies("invoices", { columns: table }),
  ],
);

const VAT_TREATMENT_SQL_VALUES = VAT_TREATMENTS.map((treatment) =>
  sql.raw(`'${treatment}'`),
);
const INVOICE_LINE_SOURCE_SQL_VALUES = INVOICE_LINE_SOURCES.map((source) =>
  sql.raw(`'${source}'`),
);

/**
 * One line of an invoice. `netAmount` is authoritative: quantity times unit
 * price for a manual line, the entry's own billed amount for a time entry or
 * an expense. VAT and gross come from `calculateDocumentTotals`
 * (`@stll/invoicing`) and are stored with the line.
 *
 * A time entry or expense is billed by at most one line whose invoice is not
 * void. Voiding an invoice stamps `releasedAt` on its lines, which keeps them
 * on the voided document and takes them out of the partial unique indexes,
 * so the entry can be billed again. A released line may lose its source
 * reference when that entry is later deleted; a line that still bills its
 * entry must keep it, so deleting a billed entry is refused.
 */
export const invoiceLines = p.pgTable(
  "invoice_lines",
  {
    id: pUuid<"invoiceLine">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    invoiceId: safeUuid<"invoice">("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    billingPurpose: p
      .text("billing_purpose", {
        enum: INVOICE_BILLING_PURPOSE_VALUES,
      })
      .notNull()
      .default(INVOICE_BILLING_PURPOSE.ORDINARY),
    position: p.integer().notNull(),
    description: p.text().notNull(),
    quantity: p.numeric({ precision: 18, scale: 4 }).notNull(),
    unit: p.varchar({ length: 32 }),
    unitPrice: centsColumn("unit_price").notNull(),
    vatRateBps: p.integer("vat_rate_bps").notNull(),
    vatTreatment: p.text("vat_treatment", { enum: VAT_TREATMENTS }).notNull(),
    netAmount: centsColumn("net_amount").notNull(),
    vatAmount: centsColumn("vat_amount").notNull(),
    grossAmount: centsColumn("gross_amount").notNull(),
    source: p.text("source", { enum: INVOICE_LINE_SOURCES }).notNull(),
    // A released line outlives its source: once the entry is back in the
    // ledger it may be deleted, and the voided document keeps the line.
    timeEntryId: safeUuid<"timeEntry">("time_entry_id").references(
      () => timeEntries.id,
      { onDelete: "set null" },
    ),
    expenseId: safeUuid<"expense">("expense_id").references(() => expenses.id, {
      onDelete: "set null",
    }),
    releasedAt: timestamptz("released_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "invoice_lines_billing_purpose_check",
      sql`${table.billingPurpose} IN (${sql.join(
        INVOICE_BILLING_PURPOSE_VALUES.map((value) => sql`${value}`),
        sql`, `,
      )}) AND (${table.billingPurpose} <> 'flat_fee' OR ${table.source} = 'manual')`,
    ),
    p
      .foreignKey({
        columns: [table.workspaceId, table.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
        name: "invoice_lines_workspace_organization_fk",
      })
      .onDelete("cascade"),
    p
      .index("invoice_lines_invoice_position_idx")
      .on(table.invoiceId, table.position, table.id),
    p.index("invoice_lines_time_entry_idx").on(table.timeEntryId),
    p.index("invoice_lines_expense_idx").on(table.expenseId),
    p
      .uniqueIndex("invoice_lines_time_entry_billed_uidx")
      .on(table.timeEntryId)
      .where(
        sql`${table.timeEntryId} IS NOT NULL AND ${table.releasedAt} IS NULL`,
      ),
    p
      .uniqueIndex("invoice_lines_expense_billed_uidx")
      .on(table.expenseId)
      .where(
        sql`${table.expenseId} IS NOT NULL AND ${table.releasedAt} IS NULL`,
      ),
    p.check(
      "invoice_lines_source_check",
      sql`${table.source} in (${sql.join(INVOICE_LINE_SOURCE_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "invoice_lines_source_reference_check",
      sql`(${table.source} = 'manual' AND ${table.timeEntryId} IS NULL AND ${table.expenseId} IS NULL) OR (${table.source} = 'time_entry' AND (${table.timeEntryId} IS NOT NULL OR ${table.releasedAt} IS NOT NULL) AND ${table.expenseId} IS NULL) OR (${table.source} = 'expense' AND (${table.expenseId} IS NOT NULL OR ${table.releasedAt} IS NOT NULL) AND ${table.timeEntryId} IS NULL)`,
    ),
    p.check(
      "invoice_lines_vat_treatment_check",
      sql`${table.vatTreatment} in (${sql.join(VAT_TREATMENT_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "invoice_lines_vat_rate_check",
      sql`${table.vatRateBps} between 0 and 10000`,
    ),
    p.check(
      "invoice_lines_amounts_check",
      sql`${table.quantity} >= 0 AND ${table.unitPrice} >= 0 AND ((${table.netAmount} >= 0 AND ${table.vatAmount} >= 0) OR (${table.netAmount} <= 0 AND ${table.vatAmount} <= 0)) AND ${table.grossAmount} = ${table.netAmount} + ${table.vatAmount}`,
    ),
    p.check("invoice_lines_position_check", sql`${table.position} >= 0`),
    p.check(
      "invoice_lines_description_check",
      sql`length(${table.description}) between 1 and 10000`,
    ),
    ...wsOrganizationPolicies("invoice_lines", { columns: table }),
  ],
);

export const vatRates = p.pgTable(
  "vat_rates",
  {
    id: pUuid<"vatRate">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    code: p.varchar({ length: 64 }).notNull(),
    name: p.varchar({ length: 128 }).notNull(),
    rateBps: p.integer("rate_bps").notNull(),
    validFrom: p.date("valid_from").notNull(),
    validTo: p.date("valid_to"),
    archivedAt: timestamptz("archived_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("vat_rates_org_created_idx")
      .on(table.organizationId, table.createdAt, table.id)
      .where(sql`${table.archivedAt} IS NULL`),
    p
      .index("vat_rates_org_code_valid_idx")
      .on(table.organizationId, table.code, table.validFrom)
      .where(sql`${table.archivedAt} IS NULL`),
    p.check("vat_rates_rate_bps_check", sql`${table.rateBps} >= 0`),
    p.check(
      "vat_rates_validity_check",
      sql`${table.validTo} IS NULL OR ${table.validTo} > ${table.validFrom}`,
    ),
    ...orgPolicies(),
  ],
);

const TIMER_SIGNAL_MEMBER_CHECK = sql`(
  "time_entry_timer_states"."organization_id" = (SELECT current_setting('app.organization_id', true))
  AND EXISTS (
    SELECT 1 FROM ${member}
    WHERE ${member.organizationId} = "time_entry_timer_states"."organization_id"
      AND ${member.userId} = (SELECT current_setting('app.user_id', true))
  )
)`;
const TIMER_SIGNAL_VISIBILITY_CHECK = sql`(
  ${TIMER_SIGNAL_MEMBER_CHECK}
  AND (
    "time_entry_timer_states"."user_id" = (SELECT current_setting('app.user_id', true))
    OR EXISTS (
      SELECT 1 FROM ${timeEntries}
      WHERE ${timeEntries.id} = "time_entry_timer_states"."entry_id"
        AND ${timeEntries.organizationId} = "time_entry_timer_states"."organization_id"
        AND ${timeEntries.userId} = "time_entry_timer_states"."user_id"
    )
  )
)`;
const TIMER_SIGNAL_WRITER_CHECK = sql`(
  ${TIMER_SIGNAL_MEMBER_CHECK}
  AND (
    "time_entry_timer_states"."user_id" = (SELECT current_setting('app.user_id', true))
    OR ${timerOrganizationAdminCheck("time_entry_timer_states")}
  )
)`;
const TIMER_SIGNAL_PROVENANCE_CHECK = sql`EXISTS (
  SELECT 1 FROM ${timeTimers}
  WHERE ${timeTimers.organizationId} = "time_entry_timer_states"."organization_id"
    AND ${timeTimers.userId} = "time_entry_timer_states"."user_id"
    AND ${timeTimers.legacyTimeEntryId} = "time_entry_timer_states"."entry_id"
)`;
const TIMER_SIGNAL_TRUTH_CHECK = sql`(
  ("time_entry_timer_states"."state" = 'running') = EXISTS (
    SELECT 1 FROM ${timeTimers}
    WHERE ${timeTimers.organizationId} = "time_entry_timer_states"."organization_id"
      AND ${timeTimers.userId} = "time_entry_timer_states"."user_id"
      AND ${timeTimers.legacyTimeEntryId} = "time_entry_timer_states"."entry_id"
      AND ${timeTimers.state} = 'running'
  )
)`;

export const timeEntryTimerStates = p.pgTable(
  "time_entry_timer_states",
  {
    entryId: safeUuid<"timeEntry">("entry_id")
      .primaryKey()
      .references(() => timeEntries.id, { onDelete: "cascade" }),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    state: p.text("state", { enum: TIME_TIMER_STATES }).notNull(),
  },
  (table) => [
    p
      .index("time_entry_timer_states_org_entry_idx")
      .on(table.organizationId, table.entryId),
    p.check(
      "time_entry_timer_states_state_check",
      sql`${table.state} IN (${sql.join(TIME_TIMER_STATE_SQL_VALUES, sql`, `)})`,
    ),
    p.pgPolicy("member_select", {
      for: "select",
      to: stella,
      using: TIMER_SIGNAL_VISIBILITY_CHECK,
    }),
    p.pgPolicy("owner_admin_insert", {
      for: "insert",
      to: stella,
      withCheck: sql`(${TIMER_SIGNAL_WRITER_CHECK} AND ${TIMER_SIGNAL_TRUTH_CHECK} AND ${TIMER_SIGNAL_PROVENANCE_CHECK})`,
    }),
    p.pgPolicy("owner_admin_update", {
      for: "update",
      to: stella,
      using: TIMER_SIGNAL_WRITER_CHECK,
      withCheck: sql`(${TIMER_SIGNAL_WRITER_CHECK} AND ${TIMER_SIGNAL_TRUTH_CHECK})`,
    }),
  ],
);

// Receipts survive edits or deletion of individual drafts so a network retry
// cannot recreate a reviewed batch. Only the authenticated owner can read it.
export const desktopTimeEntryBatches = p.pgTable(
  "desktop_time_entry_batches",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    idempotencyKey: p.varchar("idempotency_key", { length: 128 }).notNull(),
    requestFingerprint: p
      .varchar("request_fingerprint", { length: 64 })
      .notNull(),
    result: p.jsonb().$type<DesktopTimeEntryBatchResponse>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.primaryKey({
      name: "desktop_time_entry_batches_pkey",
      columns: [table.organizationId, table.userId, table.idempotencyKey],
    }),
    p.check(
      "desktop_time_entry_batches_key_check",
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    p.check(
      "desktop_time_entry_batches_fingerprint_check",
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    ...userOrganizationPolicies(),
  ],
);
