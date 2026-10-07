import { PROVIDER_EVENT_REPLAY_AUDIT_TEXT_PATH } from "@/api/lib/hosted-usage-provider/replay-audit";
import type { ProviderEventReplayAudit } from "@/api/lib/hosted-usage-provider/replay-audit";
import { CONFIGURED_ACCESS_STATUSES } from "@/api/lib/usage/configured-access";

import {
  destructiveEffectChunkColumns,
  destructiveEffectChunkConstraints,
} from "./cleanup-ledgers";
import {
  jsonb,
  member,
  organization,
  organizationCheck,
  orgReadOnlyPolicies,
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
} from "./common";
import { workspaces } from "./contacts";
import {
  USAGE_ACTION_TYPES,
  USAGE_ALLOCATION_REASONS,
  USAGE_ALLOCATION_SOURCES,
  USAGE_ENTITLEMENT_SOURCES,
  USAGE_ENTITLEMENT_STATUSES,
  type UsageEntitlementStatus,
  USAGE_PROVIDER_WEBHOOK_RESULTS,
  USAGE_SERVICE_TIERS,
} from "./skills";

export const CLOSED_USAGE_ENTITLEMENT_STATUSES = [
  "paused",
  "cancelled",
] as const satisfies readonly UsageEntitlementStatus[];
const CLOSED_USAGE_ENTITLEMENT_STATUS_SQL_VALUES =
  CLOSED_USAGE_ENTITLEMENT_STATUSES.map((status) => sql.raw(`'${status}'`));

/**
 * `free` is the no-cost floor an organization falls back to once its
 * evaluation or paid access lapses. At most one active `free` policy exists
 * (partial unique index); its limits are read through the
 * `organization_effective_policy` database function.
 */
export const USAGE_POLICY_KINDS = ["subscription", "addon", "free"] as const;
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
    storageBytesPerAssignment: p.bigint("storage_bytes_per_assignment", {
      mode: "bigint",
    }),
    // Operator-seeded member bound, read through the
    // `organization_member_capacity` database function together with the
    // seat count of a per-seat policy. Null = the policy sets no bound.
    maxMembers: p.integer("max_members"),
    serviceActionsPerPeriod: p.integer("service_actions_per_period"),
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
    p.check(
      "usage_policies_storage_bytes_nonneg",
      sql`storage_bytes_per_assignment IS NULL OR storage_bytes_per_assignment >= 0`,
    ),
    p.check(
      "usage_policies_max_members_positive",
      sql`max_members IS NULL OR max_members > 0`,
    ),
    p
      .uniqueIndex("usage_policies_hosted_policy_ref_uidx")
      .on(table.hostedPolicyRef)
      .where(sql`hosted_policy_ref IS NOT NULL`),
    p
      .uniqueIndex("usage_policies_free_active_uidx")
      .on(table.kind)
      .where(sql`kind = 'free' AND active`),
    // The free floor is never checkout-able, costs nothing, and bounds every
    // limit it applies: members, organization storage and service actions.
    p.check(
      "usage_policies_free_shape",
      sql`kind <> 'free' OR (hosted_policy_ref IS NULL AND COALESCE(price_amount_cents, 0) = 0 AND max_members IS NOT NULL AND storage_bytes_per_assignment IS NOT NULL AND service_actions_per_period IS NOT NULL)`,
    ),
    p.check(
      "usage_policies_service_actions_positive",
      sql`service_actions_per_period IS NULL OR service_actions_per_period > 0`,
    ),
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
     * retry backoff per event); dispatch rejects older events and resolves
     * equal versions by external generation and terminal state. Null when
     * the provider payload carries no timestamp (ordering then remains
     * delivery-order, as before).
     */
    hostedLastEventAt: timestamptz("hosted_last_event_at"),
    /** Provider creation time identifies the current external generation. */
    hostedEntitlementCreatedAt: timestamptz("hosted_entitlement_created_at"),
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
      sql`current_period_end > current_period_start OR (current_period_end = current_period_start AND status IN (${sql.join(CLOSED_USAGE_ENTITLEMENT_STATUS_SQL_VALUES, sql`, `)}))`,
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

const currentUserOwnsHostedCheckoutClaims = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.hosted_checkout_claims'::regclass)`;

/**
 * The organization's open hosted subscription checkout, at most one. A
 * checkout start claims the row before it calls the provider; the claim
 * holds until the provider session expires, the start fails, or the
 * subscription event arrives. An expired claim is taken over in place.
 */
export const hostedCheckoutClaims = p.pgTable(
  "hosted_checkout_claims",
  {
    organizationId: safeOrganizationId("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Identifies one start, so a stale request releases only its own claim. */
    claimId: safeUuid<"hostedCheckoutClaim">("claim_id").notNull(),
    hostedSessionId: p.text("hosted_session_id"),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  () => [
    // Members with organization settings access start checkouts through the
    // scoped connection; the webhook dispatcher clears claims on the owner
    // connection.
    p.pgPolicy("hosted_checkout_claims_owner", {
      for: "all",
      to: "public",
      using: currentUserOwnsHostedCheckoutClaims,
      withCheck: currentUserOwnsHostedCheckoutClaims,
    }),
    p.pgPolicy("hosted_checkout_claims_organization_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("hosted_checkout_claims_organization_insert", {
      for: "insert",
      to: stella,
      withCheck: organizationCheck,
    }),
    p.pgPolicy("hosted_checkout_claims_organization_update", {
      for: "update",
      to: stella,
      using: organizationCheck,
      withCheck: organizationCheck,
    }),
    p.pgPolicy("hosted_checkout_claims_organization_delete", {
      for: "delete",
      to: stella,
      using: organizationCheck,
    }),
  ],
);

/**
 * How an organization may reach the instance model provider.
 * `self_managed_keys` is recorded once for organizations that existed before
 * the state was enforced: they run only on their own keys. An evaluation
 * period is started at most once per organization and ends by time or by an
 * explicit end; neither `evaluation_ended` nor `self_managed_keys` ever
 * returns to `evaluation_period`.
 */
export const ORGANIZATION_ACCESS_STATE = {
  selfManagedKeys: "self_managed_keys",
  evaluationPeriod: "evaluation_period",
  evaluationEnded: "evaluation_ended",
} as const;

const ORGANIZATION_ACCESS_STATES = [
  ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  ORGANIZATION_ACCESS_STATE.evaluationPeriod,
  ORGANIZATION_ACCESS_STATE.evaluationEnded,
] as const;

const currentUserOwnsOrganizationAccessStates = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_access_states'::regclass)`;

export const organizationAccessStates = p.pgTable(
  "organization_access_states",
  {
    organizationId: safeOrganizationId("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    state: p.text({ enum: ORGANIZATION_ACCESS_STATES }).notNull(),
    evaluationStartedAt: timestamptz("evaluation_started_at"),
    evaluationEndsAt: timestamptz("evaluation_ends_at"),
    evaluationEndedAt: timestamptz("evaluation_ended_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  () => [
    // Each state admits exactly one shape of evaluation columns, so a row
    // cannot claim an evaluation it never started or end one twice.
    p.check(
      "organization_access_states_shape",
      sql`((state = 'self_managed_keys' AND evaluation_started_at IS NULL AND evaluation_ends_at IS NULL AND evaluation_ended_at IS NULL) OR (state = 'evaluation_period' AND evaluation_ends_at > evaluation_started_at AND evaluation_ended_at IS NULL) OR (state = 'evaluation_ended' AND evaluation_ends_at > evaluation_started_at AND evaluation_ended_at IS NOT NULL)) IS TRUE`,
    ),
    // Written only by system paths on the owner connection (organization
    // creation, operator transitions); members read their own row.
    p.pgPolicy("organization_access_states_owner_select", {
      for: "select",
      to: "public",
      using: currentUserOwnsOrganizationAccessStates,
    }),
    p.pgPolicy("organization_access_states_owner_insert", {
      for: "insert",
      to: "public",
      withCheck: currentUserOwnsOrganizationAccessStates,
    }),
    p.pgPolicy("organization_access_states_owner_update", {
      for: "update",
      to: "public",
      using: currentUserOwnsOrganizationAccessStates,
      withCheck: currentUserOwnsOrganizationAccessStates,
    }),
    p.pgPolicy("organization_access_states_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("organization_access_states_no_insert", {
      as: "restrictive",
      for: "insert",
      to: stella,
      withCheck: sql`false`,
    }),
    p.pgPolicy("organization_access_states_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("organization_access_states_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);

const configuredAccessOwner = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_configured_access'::regclass)`;

// Separate from the original standing: feature disablement and older builds
// read organization_access_states without observing or rewriting this overlay.
export const organizationConfiguredAccess = p.pgTable(
  "organization_configured_access",
  {
    organizationId: safeOrganizationId("organization_id").primaryKey(),
    sourceSignature: p.text("source_signature").notNull(),
    sourceEventAt: timestamptz("source_event_at"),
    sourceEntitlementExternalId: p
      .text("source_entitlement_external_id")
      .notNull(),
    sourceEntitlementCreatedAt: timestamptz("source_entitlement_created_at"),
    sourceEntitlementStatus: p
      .text("source_entitlement_status", { enum: USAGE_ENTITLEMENT_STATUSES })
      .notNull(),
    sourceCancelAtPeriodEnd: p.boolean("source_cancel_at_period_end").notNull(),
    configuredAccessStatus: p
      .text("configured_access_status", { enum: CONFIGURED_ACCESS_STATUSES })
      .notNull(),
    configuredPeriodEndsAt: timestamptz("configured_period_ends_at"),
    paymentRetryEndsAt: timestamptz("payment_retry_ends_at"),
    serviceActionsPerPeriod: p.integer("service_actions_per_period"),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .foreignKey({
        columns: [table.organizationId],
        foreignColumns: [organization.id],
        name: "configured_access_org_fk",
      })
      .onDelete("cascade"),
    p.check(
      "organization_configured_access_source_status",
      sql`source_entitlement_status IN (${sql.join(
        USAGE_ENTITLEMENT_STATUSES.map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "organization_configured_access_shape",
      sql`((configured_access_status IN (${sql.join(
        CONFIGURED_ACCESS_STATUSES.filter(
          (status) => status === "active" || status === "ending",
        ).map((status) => sql.raw(`'${status}'`)),
        sql`, `,
      )}) AND configured_period_ends_at IS NOT NULL AND payment_retry_ends_at IS NULL AND service_actions_per_period > 0) OR (configured_access_status = 'payment_retry' AND configured_period_ends_at IS NOT NULL AND payment_retry_ends_at IS NOT NULL AND service_actions_per_period > 0) OR (configured_access_status = 'disabled' AND configured_period_ends_at IS NULL AND payment_retry_ends_at IS NULL AND service_actions_per_period IS NULL)) IS TRUE`,
    ),
    p.pgPolicy("organization_configured_access_owner", {
      for: "all",
      to: "public",
      using: configuredAccessOwner,
      withCheck: configuredAccessOwner,
    }),
    ...orgReadOnlyPolicies("organization_configured_access"),
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
    ...destructiveEffectChunkColumns(),
  },
  (table) =>
    destructiveEffectChunkConstraints({
      table,
      requestIdColumn: accountDeletionRequests.id,
      prefix: "account_deletion_effect_chunks",
    }),
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
    actionKind: p.text("action_kind"),
    logicalPhaseId: p.text("logical_phase_id"),
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
    p
      .index("usage_events_org_cost_period_idx")
      .on(
        table.organizationId,
        table.createdAt,
        table.actionKind,
        table.logicalPhaseId,
      ),
    p.check(
      "usage_events_action_identity_pair",
      sql`(action_kind IS NULL) = (logical_phase_id IS NULL)`,
    ),
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

export const FILE_USAGE_OBJECT_STATUSES = ["reserved", "committed"] as const;
const FILE_USAGE_OBJECT_STATUS_SQL_VALUES = FILE_USAGE_OBJECT_STATUSES.map(
  (status) => sql.raw(`'${status}'`),
);
const currentUserOwnsOrganizationFileUsage = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_file_usage'::regclass)`;
const currentUserOwnsOrganizationFileObjects = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.organization_file_objects'::regclass)`;

export const organizationFileUsage = p.pgTable(
  "organization_file_usage",
  {
    organizationId: safeOrganizationId("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    committedBytes: p
      .bigint("committed_bytes", { mode: "bigint" })
      .notNull()
      .default(0n),
    reservedBytes: p
      .bigint("reserved_bytes", { mode: "bigint" })
      .notNull()
      .default(0n),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  () => [
    p.check(
      "organization_file_usage_nonneg",
      sql`committed_bytes >= 0 AND reserved_bytes >= 0`,
    ),
    p.pgPolicy("organization_file_usage_owner_access", {
      for: "all",
      to: "public",
      using: currentUserOwnsOrganizationFileUsage,
      withCheck: currentUserOwnsOrganizationFileUsage,
    }),
    p.pgPolicy("organization_file_usage_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("organization_file_usage_no_insert", {
      as: "restrictive",
      for: "insert",
      to: stella,
      withCheck: sql`false`,
    }),
    p.pgPolicy("organization_file_usage_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("organization_file_usage_no_delete", {
      as: "restrictive",
      for: "delete",
      to: stella,
      using: sql`false`,
    }),
  ],
);

export const organizationFileObjects = p.pgTable(
  "organization_file_objects",
  {
    objectKey: p.text("object_key").primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sizeBytes: p.bigint("size_bytes", { mode: "bigint" }).notNull(),
    pendingSizeBytes: p.bigint("pending_size_bytes", { mode: "bigint" }),
    writeId: p.text("write_id"),
    expectedSha256Hex: p.text("expected_sha256_hex"),
    reservationStartedAt: timestamptz("reservation_started_at"),
    status: p.text({ enum: FILE_USAGE_OBJECT_STATUSES }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("organization_file_objects_org_key_idx")
      .on(table.organizationId, table.objectKey),
    p
      .index("organization_file_objects_pending_reconcile_idx")
      .on(table.updatedAt, table.objectKey)
      .where(sql`${table.writeId} IS NOT NULL`),
    p
      .index("organization_file_objects_org_pending_reconcile_idx")
      .on(table.organizationId, table.updatedAt, table.objectKey)
      .where(sql`${table.writeId} IS NOT NULL`),
    p.check("organization_file_objects_size_nonneg", sql`size_bytes >= 0`),
    p.check(
      "organization_file_objects_pending_size_nonneg",
      sql`pending_size_bytes IS NULL OR pending_size_bytes >= 0`,
    ),
    p.check(
      "organization_file_objects_pending_committed",
      sql`status = 'committed' OR pending_size_bytes IS NULL`,
    ),
    p.check(
      "organization_file_objects_reservation_identity",
      sql`(write_id IS NULL AND reservation_started_at IS NULL AND expected_sha256_hex IS NULL AND pending_size_bytes IS NULL) OR (write_id IS NOT NULL AND reservation_started_at IS NOT NULL)`,
    ),
    p.check(
      "organization_file_objects_status_domain",
      sql`status IN (${sql.join(FILE_USAGE_OBJECT_STATUS_SQL_VALUES, sql`, `)})`,
    ),
    p.pgPolicy("organization_file_objects_owner_access", {
      for: "all",
      to: "public",
      using: currentUserOwnsOrganizationFileObjects,
      withCheck: currentUserOwnsOrganizationFileObjects,
    }),
    p.pgPolicy("organization_file_objects_select", {
      for: "select",
      to: stella,
      using: organizationCheck,
    }),
    p.pgPolicy("organization_file_objects_no_insert", {
      as: "restrictive",
      for: "insert",
      to: stella,
      withCheck: sql`false`,
    }),
    p.pgPolicy("organization_file_objects_no_update", {
      as: "restrictive",
      for: "update",
      to: stella,
      using: sql`false`,
    }),
    p.pgPolicy("organization_file_objects_no_delete", {
      as: "restrictive",
      for: "delete",
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
    // Ordered replay attempts survive redaction; ignored attempts remain eligible.
    replayAudit: jsonb("replay_audit").$type<ProviderEventReplayAudit>(),
  },
  (table) => [
    p
      .index("usage_provider_webhook_events_processed_at_idx")
      .on(table.processedAt),
    p
      .index("usage_provider_webhook_events_retention_idx")
      .on(table.processedAt)
      .where(
        sql`result IN ('ok', 'ignored') AND (payload <> '{}'::jsonb OR error_message IS NOT NULL OR replay_audit @? ${PROVIDER_EVENT_REPLAY_AUDIT_TEXT_PATH})`,
      ),
    p
      .index("usage_provider_webhook_events_ignored_entity_idx")
      .on(sql`(${table.payload}->'data'->>'id')`)
      .where(sql`result = 'ignored'`),
    p
      .index("usage_provider_webhook_events_ignored_account_idx")
      .on(sql`(${table.payload}->'data'->>'account_ref')`)
      .where(sql`result = 'ignored'`),
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
