import {
  jsonb,
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
  userPolicies,
} from "./common";
import type {
  AccountDeletionRequestStatus,
  AccountDeletionStorageCleanup,
} from "./common";
import { workspaces } from "./contacts";
import {
  USAGE_ACTION_TYPES,
  USAGE_ALLOCATION_REASONS,
  USAGE_ALLOCATION_SOURCES,
  USAGE_ENTITLEMENT_SOURCES,
  USAGE_ENTITLEMENT_STATUSES,
  USAGE_PROVIDER_WEBHOOK_RESULTS,
  USAGE_SERVICE_TIERS,
} from "./skills";

export const usagePolicies = p.pgTable(
  "usage_policies",
  {
    id: pUuid<"usagePolicy">().primaryKey(),
    policyKey: p.varchar("policy_key", { length: 64 }).notNull(),
    displayName: p.varchar("display_name", { length: 128 }).notNull(),
    monthlyUsageUnits: p.integer("monthly_usage_units").notNull(),
    hostedPolicyRef: p.text("hosted_policy_ref"),
    active: p.boolean().notNull().default(true),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("usage_policies_key_active_idx").on(table.policyKey, table.active),
    p.uniqueIndex("usage_policies_policy_key_uidx").on(table.policyKey),
    p
      .uniqueIndex("usage_policies_hosted_policy_ref_uidx")
      .on(table.hostedPolicyRef)
      .where(sql`hosted_policy_ref IS NOT NULL`),
    p.check(
      "usage_policies_policy_key_format",
      sql`policy_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`,
    ),
    p.check(
      "usage_policies_monthly_usage_units_nonneg",
      sql`monthly_usage_units >= 0`,
    ),
    // Global config: any authenticated stella session may read
    // policies; writes are performed via migrations and the root connection,
    // never via stella.
    p.pgPolicy("usage_policies_select", {
      for: "select",
      to: stella,
      using: sql`true`,
    }),
  ],
);

export const usageEntitlements = p.pgTable(
  "usage_entitlements",
  {
    id: pUuid<"usageEntitlement">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    usagePolicyId: safeUuid<"usagePolicy">("usage_policy_id")
      .notNull()
      .references(() => usagePolicies.id, { onDelete: "restrict" }),
    status: p.text({ enum: USAGE_ENTITLEMENT_STATUSES }).notNull(),
    seats: p.integer().notNull(),
    currentPeriodStart: p
      .timestamp("current_period_start", { withTimezone: true })
      .notNull(),
    currentPeriodEnd: p
      .timestamp("current_period_end", { withTimezone: true })
      .notNull(),
    hostedAccountRef: p.text("hosted_account_ref"),
    hostedEntitlementExternalId: p.text("hosted_entitlement_external_id"),
    /**
     * True when hosted access is scheduled to end but remains
     * usable until `current_period_end`. UI surfaces it as
     * "Ends on <date>" instead of bare "Cancelled". Mirrors the
     * hosted-provider period-end cancellation state.
     */
    cancelAtPeriodEnd: p
      .boolean("cancel_at_period_end")
      .notNull()
      .default(false),
    source: p.text({ enum: USAGE_ENTITLEMENT_SOURCES }).notNull(),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .uniqueIndex("usage_entitlements_organization_id_uidx")
      .on(table.organizationId),
    p
      .uniqueIndex("usage_entitlements_hosted_entitlement_external_id_uidx")
      .on(table.hostedEntitlementExternalId)
      .where(sql`hosted_entitlement_external_id IS NOT NULL`),
    // A hosted account reference maps to exactly one Stella organisation.
    // Without this constraint, account-to-entitlement lookup is
    // non-deterministic when two rows share a reference, and a provider
    // allocation could be attributed to the wrong org's period (the
    // metadata mismatch check would then drop the allocation silently).
    p
      .uniqueIndex("usage_entitlements_hosted_account_ref_uidx")
      .on(table.hostedAccountRef)
      .where(sql`hosted_account_ref IS NOT NULL`),
    p.check("usage_entitlements_seats_positive", sql`seats > 0`),
    p.check(
      "usage_entitlements_period_order",
      sql`current_period_end > current_period_start`,
    ),
    // Entitlements are owned by system paths (hosted webhook adapter
    // via rootDb, or future admin tools also via rootDb), not by org
    // members. Org members must be able to READ their own entitlement
    // state (settings page, usage UI) but never mutate it through any
    // app-scoped path. RESTRICTIVE
    // deny on INSERT/UPDATE/DELETE structurally backs that even
    // if a future permissive policy is accidentally added.
    p.pgPolicy("usage_entitlements_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("usage_entitlements_no_insert", {
      as: "restrictive",
      for: "insert",
      to: stella,
      withCheck: sql`false`,
    }),
    p.pgPolicy("usage_entitlements_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("usage_entitlements_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);

export const usageAllocations = p.pgTable(
  "usage_allocations",
  {
    id: pUuid<"usageAllocation">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    periodStart: p.timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: p.timestamp("period_end", { withTimezone: true }).notNull(),
    units: p.integer().notNull(),
    reason: p.text({ enum: USAGE_ALLOCATION_REASONS }).notNull(),
    sourceType: p
      .text("source_type", { enum: USAGE_ALLOCATION_SOURCES })
      .notNull(),
    sourceRef: p.text("source_ref"),
    /**
     * For allocations attached to a specific initiating seat, this
     * records that user's id for future per-seat attribution.
     * Null = org pool. Plain text (no FK) so deleting a user
     * doesn't break the ledger row.
     */
    seatScopeUserId: p.text("seat_scope_user_id"),
    allocatedByUserId: p
      .text("allocated_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("usage_allocations_org_period_idx")
      .on(table.organizationId, table.periodStart),
    p
      .uniqueIndex("usage_allocations_org_source_ref_uidx")
      .on(table.organizationId, table.sourceType, table.sourceRef)
      .where(sql`source_ref IS NOT NULL`),
    p.check("usage_allocations_units_positive", sql`units > 0`),
    p.check("usage_allocations_period_order", sql`period_end > period_start`),
    p.pgPolicy("usage_allocations_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    // Append-only AND system-owned. Legitimate writers run through
    // rootDb (webhook adapter, admin allocation tool). The app role
    // must never be able to mint an allocation for itself, even when the org id
    // matches — RESTRICTIVE deny INSERT keeps that structurally
    // impossible regardless of any future permissive policy.
    p.pgPolicy("usage_allocations_no_insert", {
      as: "restrictive",
      for: "insert",
      to: stella,
      withCheck: sql`false`,
    }),
    p.pgPolicy("usage_allocations_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("usage_allocations_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);

export const accountDeletionRequests = p.pgTable(
  "account_deletion_requests",
  {
    id: pUuid<"accountDeletionRequest">().primaryKey(),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    organizationIds: safeOrganizationId("organization_ids")
      .array()
      .notNull()
      .default([]),
    workspaceIds: safeWorkspaceId("workspace_ids")
      .array()
      .notNull()
      .default([]),
    taskReassignmentCount: p
      .integer("task_reassignment_count")
      .notNull()
      .default(0),
    status: p
      .varchar("status", { length: 16 })
      .$type<AccountDeletionRequestStatus>()
      .notNull()
      .default("pending"),
    storageCleanup: jsonb("storage_cleanup")
      .$type<AccountDeletionStorageCleanup>()
      .notNull(),
    attemptCount: p.integer("attempt_count").notNull().default(0),
    errorMessage: p.text("error_message"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
    updatedAt: p
      .timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: p.timestamp("completed_at"),
  },
  (table) => [
    p
      .index("account_deletion_requests_user_created_idx")
      .on(table.userId, table.createdAt, table.id),
    p
      .index("account_deletion_requests_status_created_idx")
      .on(table.status, table.createdAt, table.id),
    ...userPolicies(),
  ],
);

export const usageEvents = p.pgTable(
  "usage_events",
  {
    id: pUuid<"usageEvent">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: safeWorkspaceId("workspace_id").references(
      () => workspaces.id,
      { onDelete: "set null" },
    ),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    periodStart: p.timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: p.timestamp("period_end", { withTimezone: true }).notNull(),
    actionType: p.text("action_type", { enum: USAGE_ACTION_TYPES }).notNull(),
    modelRole: p.varchar("model_role", { length: 32 }).notNull(),
    unitsConsumed: p.integer("units_consumed").notNull(),
    rawUsageMicroUnits: p.bigint("raw_usage_micro_units", { mode: "number" }),
    serviceTier: p
      .text("service_tier", { enum: USAGE_SERVICE_TIERS })
      .notNull(),
    isByok: p.boolean("is_byok").notNull().default(false),
    traceId: p.text("trace_id"),
    idempotencyKey: p.text("idempotency_key"),
    createdAt: p.timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("usage_events_org_period_idx")
      .on(table.organizationId, table.periodStart),
    p
      .index("usage_events_org_user_period_idx")
      .on(table.organizationId, table.userId, table.periodStart),
    p
      .uniqueIndex("usage_events_org_idempotency_key_uidx")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    // BYOK rows land with units_consumed = 0: the work is attributed
    // to the org's configured provider account. Platform-backed rows
    // are floored at 1 in app code.
    p.check("usage_events_units_nonneg", sql`units_consumed >= 0`),
    p.check("usage_events_period_order", sql`period_end > period_start`),
    p.pgPolicy("usage_events_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("usage_events_insert", {
      for: "insert",
      to: stella,
      withCheck: organizationCheck,
    }),
    p.pgPolicy("usage_events_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("usage_events_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);

export const hostedUsageWebhookEvents = p.pgTable(
  "usage_provider_webhook_events",
  {
    // Provider event ID; making it the PK keeps duplicate deliveries
    // structural no-ops via ON CONFLICT DO NOTHING.
    eventId: p.text("event_id").primaryKey(),
    eventType: p.text("event_type").notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    processedAt: p
      .timestamp("processed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    result: p.text({ enum: USAGE_PROVIDER_WEBHOOK_RESULTS }).notNull(),
    errorMessage: p.text("error_message"),
  },
  (table) => [
    p
      .index("usage_provider_webhook_events_processed_at_idx")
      .on(table.processedAt),
    // System table: written and read only by the webhook handler via
    // the root connection. Stella sessions have no business touching it.
    p.pgPolicy("usage_provider_webhook_events_no_stella_access", {
      for: "all",
      to: stella,
      using: sql`false`,
      withCheck: sql`false`,
    }),
  ],
);

// -- Relations --
