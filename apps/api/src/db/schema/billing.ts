import {
  INVOICE_STATUS,
  INVOICE_STATUSES,
  type InvoiceStatus,
} from "@stll/api-contract";

import {
  EXPENSE_CATEGORIES,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
  centsColumn,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  unsafeCents,
  user,
  wsOrganizationPolicies,
  wsPolicies,
  timestamptz,
} from "./common";
import { workspaces } from "./contacts";
import { entities } from "./entities";

export const ACTIVE_TIMER_INDEX_NAME =
  "time_entries_one_active_timer_per_user_idx";

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
    timerStartedAt: timestamptz("timer_started_at"),
    timerStoppedAt: timestamptz("timer_stopped_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").defaultNow(),
  },
  (table) => [
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
      .index("time_entries_ws_work_item_status_idx")
      .on(table.workspaceId, table.workItemId, table.status),
    p.index("time_entries_ws_status_idx").on(table.workspaceId, table.status),
    p.index("time_entries_invoice_idx").on(table.invoiceId),
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
    ...wsOrganizationPolicies("time_entries"),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").defaultNow(),
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
    paidAt: timestamptz("paid_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("invoices_ws_status_idx").on(table.workspaceId, table.status),
    p
      .uniqueIndex("invoices_ws_number_uidx")
      .on(table.workspaceId, table.invoiceNumber),
    ...wsPolicies(),
  ],
);
