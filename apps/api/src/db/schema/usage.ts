import {
  DESTRUCTIVE_EFFECT_CHUNK_STATUSES,
  jsonb,
  member,
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
  timestamptz,
} from "./common";
import type {
  AccountDeletionRequestStatus,
  AccountDeletionStorageCleanup,
  DestructiveEffectChunkStatus,
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

export const USAGE_POLICY_KINDS = ["subscription", "addon"] as const;
export type UsagePolicyKind = (typeof USAGE_POLICY_KINDS)[number];

export const USAGE_POLICY_BILLING_INTERVALS = [
  "month",
  "year",
  "one_time",
] as const;

export const USAGE_POLICY_VISIBILITIES = ["public", "hidden"] as const;

/**
 * How the catalog price applies: `flat` = one price for the whole
 * organisation, `per_seat` = the price multiplies by purchased seats.
 * A named discriminator rather than a boolean: pricing shapes grow
 * (tiered, banded), and each addition must force a decision at every
 * read site.
 */
export const USAGE_POLICY_PRICE_BASES = ["flat", "per_seat"] as const;

/**
 * Which budget a usage event settles against. `pool` is the org-wide
 * purchased-unit ledger (the only lane before per-user budgets
 * existed); `allowance` is a user's included per-seat budget;
 * `fallback` is the reduced-cost lane served after the allowance is
 * exhausted. Only `pool` events count against the org ledger balance.
 */
export const USAGE_EVENT_LANES = ["pool", "allowance", "fallback"] as const;
export type UsageEventLane = (typeof USAGE_EVENT_LANES)[number];

/**
 * Per-user budget counters. `daily` accrues everything a user consumes
 * from the included allowance inside one UTC day; `fallback_weekly`
 * accrues fallback-lane consumption inside one UTC ISO week.
 */
export const USAGE_LANE_COUNTER_KINDS = ["daily", "fallback_weekly"] as const;
export type UsageLaneCounterKind = (typeof USAGE_LANE_COUNTER_KINDS)[number];

const USAGE_POLICY_KIND_SQL_VALUES = USAGE_POLICY_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);

const USAGE_POLICY_BILLING_INTERVAL_SQL_VALUES =
  USAGE_POLICY_BILLING_INTERVALS.map((interval) => sql.raw(`'${interval}'`));

const USAGE_POLICY_VISIBILITY_SQL_VALUES = USAGE_POLICY_VISIBILITIES.map(
  (visibility) => sql.raw(`'${visibility}'`),
);
const DESTRUCTIVE_EFFECT_CHUNK_STATUS_SQL_VALUES =
  DESTRUCTIVE_EFFECT_CHUNK_STATUSES.map((status) => sql.raw(`'${status}'`));

const USAGE_POLICY_PRICE_BASIS_SQL_VALUES = USAGE_POLICY_PRICE_BASES.map(
  (basis) => sql.raw(`'${basis}'`),
);

const USAGE_EVENT_LANE_SQL_VALUES = USAGE_EVENT_LANES.map((lane) =>
  sql.raw(`'${lane}'`),
);

const USAGE_LANE_COUNTER_KIND_SQL_VALUES = USAGE_LANE_COUNTER_KINDS.map(
  (kind) => sql.raw(`'${kind}'`),
);

export const usagePolicies = p.pgTable(
  "usage_policies",
  {
    id: pUuid<"usagePolicy">().primaryKey(),
    policyKey: p.varchar("policy_key", { length: 64 }).notNull(),
    displayName: p.varchar("display_name", { length: 128 }).notNull(),
    description: p.text(),
    kind: p
      .text({ enum: USAGE_POLICY_KINDS })
      .notNull()
      .default("subscription"),
    monthlyUsageUnits: p.integer("monthly_usage_units").notNull(),
    hostedPolicyRef: p.text("hosted_policy_ref"),
    // Catalog display data is deployment-owned (seeded from operator
    // config), so public source carries the mechanism, not a price list.
    priceAmountCents: p.integer("price_amount_cents"),
    priceCurrency: p.varchar("price_currency", { length: 3 }),
    billingInterval: p.text("billing_interval", {
      enum: USAGE_POLICY_BILLING_INTERVALS,
    }),
    priceBasis: p
      .text("price_basis", { enum: USAGE_POLICY_PRICE_BASES })
      .notNull()
      .default("flat"),
    // Per-seat budget sizes in micro-units, operator-seeded like the
    // price fields. Null = the policy grants no such budget (packs,
    // and deployments that have not opted in).
    dailyAllowanceMicroUnits: p.integer("daily_allowance_micro_units"),
    fallbackWeeklyMicroUnits: p.integer("fallback_weekly_micro_units"),
    // Hidden by default: a seeded policy only appears in the catalog
    // endpoint once the operator explicitly marks it public.
    visibility: p
      .text({ enum: USAGE_POLICY_VISIBILITIES })
      .notNull()
      .default("hidden"),
    sortOrder: p.integer("sort_order").notNull().default(0),
    active: p.boolean().notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.index("usage_policies_key_active_idx").on(table.policyKey, table.active),
    p.uniqueIndex("usage_policies_policy_key_uidx").on(table.policyKey),
    p.check(
      "usage_policies_price_amount_nonneg",
      sql`price_amount_cents IS NULL OR price_amount_cents >= 0`,
    ),
    // All three price display fields travel together: a partial price
    // (interval without amount, amount without currency) cannot render
    // in the checkout picker and would compromise the billing catalog.
    p.check(
      "usage_policies_price_fields_consistent",
      sql`(price_amount_cents IS NULL) = (price_currency IS NULL) AND (price_amount_cents IS NULL) = (billing_interval IS NULL)`,
    ),
    // Drizzle's text-enum option narrows TypeScript only; these are
    // billing-relevant domains, so invalid values are rejected by the
    // database as well (root/manual writes included).
    p.check(
      "usage_policies_kind_domain",
      sql`kind IN (${sql.join(USAGE_POLICY_KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "usage_policies_billing_interval_domain",
      sql`billing_interval IS NULL OR billing_interval IN (${sql.join(USAGE_POLICY_BILLING_INTERVAL_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "usage_policies_visibility_domain",
      sql`visibility IN (${sql.join(USAGE_POLICY_VISIBILITY_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "usage_policies_price_basis_domain",
      sql`price_basis IN (${sql.join(USAGE_POLICY_PRICE_BASIS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "usage_policies_daily_allowance_nonneg",
      sql`daily_allowance_micro_units IS NULL OR daily_allowance_micro_units >= 0`,
    ),
    p.check(
      "usage_policies_fallback_weekly_nonneg",
      sql`fallback_weekly_micro_units IS NULL OR fallback_weekly_micro_units >= 0`,
    ),
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
    /**
     * Highest seat count applied inside the current period, maintained
     * by the hosted webhook dispatcher and reset on period rollover.
     * Pro-rata unit deltas are granted only when seats exceed this
     * peak, so cycling seats down and back up inside one period cannot
     * mint capacity twice. Null on rows written before the column
     * existed; readers treat null as "peak = seats".
     */
    hostedPeakSeats: p.integer("hosted_peak_seats"),
    currentPeriodStart: timestamptz("current_period_start").notNull(),
    currentPeriodEnd: timestamptz("current_period_end").notNull(),
    hostedAccountRef: p.text("hosted_account_ref"),
    hostedEntitlementExternalId: p.text("hosted_entitlement_external_id"),
    /**
     * Provider-reported occurrence time of the last applied lifecycle
     * event. Webhook deliveries can arrive out of order (independent
     * retry backoff per event); dispatch skips events strictly older
     * than this so a stale `active` retry cannot resurrect an
     * entitlement that a newer `revoked` already terminated. Null when
     * the provider payload carries no timestamp (ordering then remains
     * delivery-order, as before).
     */
    hostedLastEventAt: timestamptz("hosted_last_event_at"),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
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
      "usage_entitlements_hosted_peak_seats_positive",
      sql`hosted_peak_seats IS NULL OR hosted_peak_seats > 0`,
    ),
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
    periodStart: timestamptz("period_start").notNull(),
    periodEnd: timestamptz("period_end").notNull(),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamptz("completed_at"),
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

/**
 * Bounded, independently claimable external effects for account erasure.
 * `storageCleanup` on the parent is a rolling-deploy bridge for API tasks that
 * predate this ledger; remove it after those tasks cannot run and every legacy
 * request has been materialized here.
 */
export const accountDeletionEffectChunks = p.pgTable.withRLS(
  "account_deletion_effect_chunks",
  {
    id: pUuid<"accountDeletionEffectChunk">().primaryKey(),
    requestId: safeUuid<"accountDeletionRequest">("request_id").notNull(),
    chunkIndex: p.integer("chunk_index").notNull(),
    effectType: p
      .text("effect_type", { enum: ["s3_delete"] })
      .notNull()
      .default("s3_delete"),
    payloadHash: p.varchar("payload_hash", { length: 64 }).notNull(),
    s3Keys: p.text("s3_keys").array().notNull(),
    status: p
      .text("status", { enum: DESTRUCTIVE_EFFECT_CHUNK_STATUSES })
      .$type<DestructiveEffectChunkStatus>()
      .notNull()
      .default("pending"),
    attemptCount: p.integer("attempt_count").notNull().default(0),
    leaseToken: safeUuid<"effectLease">("lease_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    nextAttemptAt: timestamptz("next_attempt_at"),
    errorMessage: p.text("error_message"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.requestId],
        foreignColumns: [accountDeletionRequests.id],
        name: "account_deletion_effect_chunks_request_fk",
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("account_deletion_effect_chunks_request_index_uidx")
      .on(table.requestId, table.chunkIndex),
    p
      .index("account_deletion_effect_chunks_pending_claim_idx")
      .on(table.requestId, table.chunkIndex)
      .where(sql`${table.status} = 'pending'`),
    p
      .index("account_deletion_effect_chunks_failed_claim_idx")
      .on(table.nextAttemptAt, table.requestId, table.chunkIndex)
      .where(sql`${table.status} = 'failed'`),
    p
      .index("account_deletion_effect_chunks_lease_expiry_idx")
      .on(table.leaseExpiresAt, table.requestId, table.chunkIndex)
      .where(sql`${table.status} = 'processing'`),
    p.check(
      "account_deletion_effect_chunks_status_check",
      sql`${table.status} IN (${sql.join(DESTRUCTIVE_EFFECT_CHUNK_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "account_deletion_effect_chunks_effect_type_check",
      sql`${table.effectType} = 's3_delete'`,
    ),
    p.check(
      "account_deletion_effect_chunks_attempt_nonnegative_check",
      sql`${table.attemptCount} >= 0`,
    ),
    p.check(
      "account_deletion_effect_chunks_index_nonnegative_check",
      sql`${table.chunkIndex} >= 0`,
    ),
    p.check(
      "account_deletion_effect_chunks_payload_hash_check",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "account_deletion_effect_chunks_payload_bound_check",
      sql`(${table.status} = 'completed' AND cardinality(${table.s3Keys}) = 0) OR (${table.status} <> 'completed' AND cardinality(${table.s3Keys}) BETWEEN 1 AND 50)`,
    ),
    p.check(
      "account_deletion_effect_chunks_lease_state_check",
      sql`(${table.status} = 'processing') = (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    p.check(
      "account_deletion_effect_chunks_retry_state_check",
      sql`(${table.status} = 'failed') = (${table.nextAttemptAt} IS NOT NULL)`,
    ),
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
    periodStart: timestamptz("period_start").notNull(),
    periodEnd: timestamptz("period_end").notNull(),
    actionType: p.text("action_type", { enum: USAGE_ACTION_TYPES }).notNull(),
    modelRole: p.varchar("model_role", { length: 32 }).notNull(),
    unitsConsumed: p.integer("units_consumed").notNull(),
    rawUsageMicroUnits: p.bigint("raw_usage_micro_units", { mode: "number" }),
    serviceTier: p
      .text("service_tier", { enum: USAGE_SERVICE_TIERS })
      .notNull(),
    isByok: p.boolean("is_byok").notNull().default(false),
    /**
     * Which budget this event settles against. Ledger balance sums
     * only `pool` rows; `allowance` and `fallback` rows are settled
     * by the per-user lane counters instead.
     */
    lane: p.text({ enum: USAGE_EVENT_LANES }).notNull().default("pool"),
    traceId: p.text("trace_id"),
    idempotencyKey: p.text("idempotency_key"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
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
    p.check(
      "usage_events_lane_domain",
      sql`lane IN (${sql.join(USAGE_EVENT_LANE_SQL_VALUES, sql`, `)})`,
    ),
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

/**
 * Per-user budget accumulators, one row per (org, user, kind, bucket).
 * Written in the same transaction as the usage event they settle, read
 * as a single point lookup at pre-flight — never derived by scanning
 * `usage_events`. Buckets are UTC-aligned; a new bucket row starts the
 * count at zero, which is the reset.
 */
/**
 * Which members occupy the organisation's purchased seats. Only
 * assigned members draw the per-user included budgets; everyone else
 * keeps the shared-pool path. Assignment is manager-managed and
 * bounded by the entitlement's seat count at write time.
 */
export const usageSeatAssignments = p.pgTable(
  "usage_seat_assignments",
  {
    id: pUuid<"usageSeatAssignment">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p.text("user_id").notNull(),
    assignedByUserId: p
      .text("assigned_by_user_id")
      .references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .uniqueIndex("usage_seat_assignments_org_user_uidx")
      .on(table.organizationId, table.userId),
    // Bound to the membership, not the account: removing a member from
    // the organization removes the designation with it, so an orphan
    // can neither hold capacity nor silently restore budgets on
    // re-invite.
    p
      .foreignKey({
        columns: [table.organizationId, table.userId],
        foreignColumns: [member.organizationId, member.userId],
        name: "usage_seat_assignments_member_fk",
      })
      .onDelete("cascade"),
    // Reads for any member (the lane decision runs for every user);
    // writes stay manager-gated at the handler layer on top of the
    // org check.
    p.pgPolicy("usage_seat_assignments_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("usage_seat_assignments_insert", {
      for: "insert",
      to: stella,
      withCheck: organizationCheck,
    }),
    p.pgPolicy("usage_seat_assignments_delete", {
      for: "delete",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("usage_seat_assignments_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
  ],
);

export const usageLaneCounters = p.pgTable(
  "usage_lane_counters",
  {
    id: pUuid<"usageLaneCounter">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: p.text({ enum: USAGE_LANE_COUNTER_KINDS }).notNull(),
    bucketStart: timestamptz("bucket_start").notNull(),
    microUnits: p
      .bigint("micro_units", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // The upsert target and the pre-flight point lookup.
    p
      .uniqueIndex("usage_lane_counters_org_user_kind_bucket_uidx")
      .on(table.organizationId, table.userId, table.kind, table.bucketStart),
    p.check("usage_lane_counters_micro_units_nonneg", sql`micro_units >= 0`),
    p.check(
      "usage_lane_counters_kind_domain",
      sql`kind IN (${sql.join(USAGE_LANE_COUNTER_KIND_SQL_VALUES, sql`, `)})`,
    ),
    // Counters are written from the metered request path (tenant
    // connection), so insert/update carry the org check; rows are
    // never deleted — resets happen by bucket rollover.
    p.pgPolicy("usage_lane_counters_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("usage_lane_counters_insert", {
      for: "insert",
      to: stella,
      withCheck: organizationCheck,
    }),
    p.pgPolicy("usage_lane_counters_update", {
      for: "update",
      to: stella,
      using: organizationCheck,
      withCheck: organizationCheck,
    }),
    p.pgPolicy("usage_lane_counters_no_delete", {
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
    processedAt: timestamptz("processed_at").notNull().defaultNow(),
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
