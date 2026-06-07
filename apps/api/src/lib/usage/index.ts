/**
 * Usage ledger API.
 *
 * The ledger is two append-only tables:
 *
 *   usage_allocations — usage units made available to an org
 *                       for a bounded period.
 *   usage_events      — usage units consumed by AI work.
 *
 * Balance for an organisation at instant `asOf` is:
 *
 *     SUM(allocations.units)  WHERE period covers asOf
 *   - SUM(events.units)       WHERE period covers asOf
 *
 * Periods are set at write-time from the org's active usage
 * entitlement. When the entitlement period renews, fresh
 * allocations land with a new period; consumption inside a
 * period naturally resets when that period ends and a new one
 * begins.
 *
 * Pre-flight check (`assertUsageAvailable`) and post-flight
 * record (`recordUsageEvent`) are deliberately separate: the
 * pre-flight check is a heuristic that runs *before* the AI call,
 * while `recordUsageEvent` is the source-of-truth ledger write
 * that happens *after* the call completes. A race between two
 * concurrent pre-flight checks is acceptable in v1 — the ledger
 * will go slightly negative at worst, which surfaces as an
 * over-cap warning rather than a silent loss.
 */

import { panic } from "better-result";
import { and, eq, gt, lte, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import {
  usageEvents,
  usageAllocations,
  usageEntitlements,
} from "@/api/db/schema";
import type {
  UsageActionType,
  UsageAllocationReason,
  UsageAllocationSource,
  UsageServiceTier,
  UsageEntitlementStatus,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { UsageLimitExceededError } from "@/api/lib/errors/tagged-errors";

/**
 * Entitlement statuses that allow consumption to proceed.
 * Other statuses (cancelled, paused, past_due) block AI calls
 * even if the unit balance is positive: leftover units survive
 * until the period naturally expires, but no new spend.
 */
const CONSUMABLE_STATUSES: ReadonlySet<UsageEntitlementStatus> = new Set([
  "active",
  "trialing",
]);

type EntitlementForCheck = {
  status: UsageEntitlementStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
};

const fetchEntitlement = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<EntitlementForCheck | null> => {
  const rows = await tx
    .select({
      status: usageEntitlements.status,
      currentPeriodStart: usageEntitlements.currentPeriodStart,
      currentPeriodEnd: usageEntitlements.currentPeriodEnd,
    })
    .from(usageEntitlements)
    .where(eq(usageEntitlements.organizationId, organizationId))
    .limit(1);
  return rows.at(0) ?? null;
};

type BalanceInput = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  asOf?: Date;
};

/**
 * Sum of unused units inside the period that covers `asOf`.
 * Returns 0 if no allocations exist (whether because there's no
 * entitlement or the period boundary changed cleanly).
 */
export const getRemainingUsageUnits = async ({
  tx,
  organizationId,
  asOf = new Date(),
}: BalanceInput): Promise<number> => {
  const allocatedRow = await tx
    .select({
      total: sql<number>`COALESCE(SUM(${usageAllocations.units}), 0)::int`,
    })
    .from(usageAllocations)
    .where(
      and(
        eq(usageAllocations.organizationId, organizationId),
        lte(usageAllocations.periodStart, asOf),
        gt(usageAllocations.periodEnd, asOf),
      ),
    );

  const consumedRow = await tx
    .select({
      total: sql<number>`COALESCE(SUM(${usageEvents.unitsConsumed}), 0)::int`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.organizationId, organizationId),
        lte(usageEvents.periodStart, asOf),
        gt(usageEvents.periodEnd, asOf),
      ),
    );

  const allocated = allocatedRow.at(0)?.total ?? 0;
  const consumed = consumedRow.at(0)?.total ?? 0;
  return allocated - consumed;
};

type AssertInput = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  required: number;
  asOf?: Date;
};

type AssertResult =
  | { ok: true; available: number }
  | { ok: false; error: UsageLimitExceededError };

/**
 * Pre-flight check. Returns either the available balance (when
 * sufficient) or a tagged `UsageLimitExceededError` describing
 * why the call should be rejected. Callers map the error to an
 * HTTP 402 + usage-limit response at the route boundary.
 */
export const assertUsageAvailable = async ({
  tx,
  organizationId,
  required,
  asOf = new Date(),
}: AssertInput): Promise<AssertResult> => {
  const entitlement = await fetchEntitlement(tx, organizationId);

  if (entitlement === null) {
    return {
      ok: false,
      error: new UsageLimitExceededError({
        message: "Organisation has no active usage entitlement",
        required,
        available: 0,
        reason: "no_entitlement",
      }),
    };
  }

  if (!CONSUMABLE_STATUSES.has(entitlement.status)) {
    return {
      ok: false,
      error: new UsageLimitExceededError({
        message: `Usage entitlement is ${entitlement.status} and cannot consume units`,
        required,
        available: 0,
        reason: "entitlement_inactive",
      }),
    };
  }

  const available = await getRemainingUsageUnits({ tx, organizationId, asOf });

  if (available < required) {
    return {
      ok: false,
      error: new UsageLimitExceededError({
        message: `Usage limit exceeded: need ${required}, have ${available}`,
        required,
        available,
        reason: "usage_limit_exceeded",
      }),
    };
  }

  return { ok: true, available };
};

type RecordUsageEventInput = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  userId: string;
  actionType: UsageActionType;
  modelRole: string;
  unitsConsumed: number;
  serviceTier: UsageServiceTier;
  isByok: boolean;
  rawUsageMicroUnits?: number | null;
  traceId?: string | null;
  /**
   * Optional period override. Default: look up the entitlement
   * and use its active period. Passing explicit period is useful
   * in tests and for replaying historical events.
   */
  period?: { start: Date; end: Date };
};

/**
 * Append a usage event. Does NOT check balance — that's the
 * pre-flight's job. Failures bubble up so callers can decide
 * whether to capture-and-continue or surface to the user. Most
 * callers should wrap in `Result.tryPromise` so an analytics
 * outage cannot crash the AI stream itself.
 */
export const recordUsageEvent = async ({
  tx,
  organizationId,
  workspaceId,
  userId,
  actionType,
  modelRole,
  unitsConsumed,
  serviceTier,
  isByok,
  rawUsageMicroUnits = null,
  traceId = null,
  period,
}: RecordUsageEventInput): Promise<void> => {
  const periodResolved = period ?? (await resolvePeriod(tx, organizationId));

  await tx.insert(usageEvents).values({
    organizationId,
    workspaceId,
    userId,
    periodStart: periodResolved.start,
    periodEnd: periodResolved.end,
    actionType,
    modelRole,
    unitsConsumed,
    serviceTier,
    isByok,
    rawUsageMicroUnits,
    traceId,
  });
};

type AllocateUsageInput = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  units: number;
  reason: UsageAllocationReason;
  sourceType: UsageAllocationSource;
  sourceRef: string | null;
  /**
   * For allocations attached to a specific initiating seat, set this
   * to that user's id. Null = org pool.
   */
  seatScopeUserId?: string | null;
  allocatedByUserId?: string | null;
  period: { start: Date; end: Date };
};

type AllocateUsageResult =
  | { status: "allocated"; id: SafeId<"usageAllocation"> }
  | { status: "duplicate" }
  | { status: "skipped" };

/**
 * Append an allocation. Idempotent against duplicate `sourceRef` —
 * a re-delivered webhook or replayed admin action becomes
 * a structural no-op rather than a double-allocation. When `sourceRef`
 * is null (genuine manual allocation with no external reference), the
 * insert always succeeds.
 */
export const allocateUsage = async ({
  tx,
  organizationId,
  units,
  reason,
  sourceType,
  sourceRef,
  seatScopeUserId = null,
  allocatedByUserId = null,
  period,
}: AllocateUsageInput): Promise<AllocateUsageResult> => {
  // A zero-unit policy (e.g. a BYOK-only tier) grants no platform
  // capacity. usage_allocations_units_positive forbids a 0-unit row, so
  // there is nothing to allocate — skip rather than fail the insert and
  // roll back the caller's transaction.
  if (units <= 0) {
    return { status: "skipped" };
  }

  const values = {
    organizationId,
    periodStart: period.start,
    periodEnd: period.end,
    units,
    reason,
    sourceType,
    sourceRef,
    seatScopeUserId,
    allocatedByUserId,
  };

  // The idempotency unique index is partial — it only applies when
  // sourceRef IS NOT NULL. With a null sourceRef there is no
  // conflict target Postgres can match, so we skip ON CONFLICT and
  // let the insert proceed. Genuine manual allocations (no external
  // reference) are intentionally allowed to repeat.
  if (sourceRef === null) {
    const inserted = await tx
      .insert(usageAllocations)
      .values(values)
      .returning({ id: usageAllocations.id });
    const row = inserted.at(0);
    if (!row) {
      // Insert without ON CONFLICT cannot silently no-op; if no row
      // came back the driver is in an unexpected state.
      panic("usage_allocations insert returned no rows");
    }
    return { status: "allocated", id: row.id };
  }

  const inserted = await tx
    .insert(usageAllocations)
    .values(values)
    .onConflictDoNothing({
      target: [
        usageAllocations.organizationId,
        usageAllocations.sourceType,
        usageAllocations.sourceRef,
      ],
      where: sql`source_ref IS NOT NULL`,
    })
    .returning({ id: usageAllocations.id });

  const row = inserted.at(0);
  if (!row) {
    return { status: "duplicate" };
  }
  return { status: "allocated", id: row.id };
};

const resolvePeriod = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<{ start: Date; end: Date }> => {
  const entitlement = await fetchEntitlement(tx, organizationId);
  if (entitlement === null) {
    // System-initiated calls (background enrichment) may have no
    // entitlement; bucket their consumption into a synthetic
    // "month containing now" period so balance math is well-defined.
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    return { start, end };
  }
  return {
    start: entitlement.currentPeriodStart,
    end: entitlement.currentPeriodEnd,
  };
};
