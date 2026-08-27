/**
 * Per-event handlers for the hosted usage webhook adapter.
 *
 * Each handler takes a typed payload and a transaction, mutates
 * entitlement/allocation state, and returns a discriminated result.
 * Receive-side concerns (signature verification, dedup, HTTP
 * status mapping) live in `receive.ts`.
 *
 * Ownership rule (per /conventions-security): organisation_id is
 * resolved by joining on provider account / entitlement ids
 * recorded on the local `usage_entitlements` row. Provider metadata is
 * only trusted on the first entitlement mapping or after the
 * local account id has already been mapped to an organisation.
 */

import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  usagePolicies,
  usageEntitlements,
  usageSeatAssignments,
} from "@/api/db/schema";
import type { UsageEntitlementStatus, UsagePolicyKind } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  HostedUsageAllocationPayload,
  HostedUsageEntitlementPayload,
} from "@/api/lib/hosted-usage-provider/event-schemas";
import { recordWebhookAuditEvent } from "@/api/lib/hosted-usage-provider/webhook-store";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import {
  lockAssignmentCapacity,
  trimAssignmentsToCapacity,
} from "@/api/lib/usage/assignment-capacity";
import { allocateUsage } from "@/api/lib/usage/usage-ledger";

export type DispatchOutcome =
  | { kind: "applied"; entitlementId: SafeId<"usageEntitlement"> }
  | { kind: "duplicate_allocation" }
  | { kind: "ignored"; reason: string };

type PolicyLookup = {
  id: SafeId<"usagePolicy">;
  monthlyUsageUnits: number;
};

const resolvePolicyByHostedPolicyRef = async (
  tx: Transaction,
  hostedPolicyRef: string,
  expectedKind: UsagePolicyKind,
): Promise<PolicyLookup | null> => {
  const rows = await tx
    .select({
      id: usagePolicies.id,
      monthlyUsageUnits: usagePolicies.monthlyUsageUnits,
    })
    .from(usagePolicies)
    .where(
      and(
        eq(usagePolicies.hostedPolicyRef, hostedPolicyRef),
        eq(usagePolicies.kind, expectedKind),
      ),
    )
    .limit(1);
  return rows.at(0) ?? null;
};

type ExistingEntitlement = {
  id: SafeId<"usageEntitlement">;
  organizationId: SafeId<"organization">;
  source: "hosted" | "manual";
  usagePolicyId: SafeId<"usagePolicy">;
  hostedLastEventAt: Date | null;
  seats: number;
  hostedPeakSeats: number | null;
  currentPeriodStart: Date;
};

/**
 * Highest seat count already granted capacity inside the row's current
 * period. Null `hostedPeakSeats` (pre-column rows) reads as the row's
 * seat count: those seats were granted by the period's periodic
 * allocation.
 */
const peakSeatsOf = (existing: ExistingEntitlement): number =>
  Math.max(existing.seats, existing.hostedPeakSeats ?? existing.seats);

/**
 * Peak to store on the row after applying an event: within the same
 * period the peak only rises; a new period resets it to the event's
 * seat count.
 */
const nextPeakSeats = (
  existing: ExistingEntitlement,
  seats: number,
  periodStart: Date,
): number =>
  existing.currentPeriodStart.getTime() === periodStart.getTime()
    ? Math.max(peakSeatsOf(existing), seats)
    : seats;

/**
 * Provider-reported occurrence time, or null when absent/unparseable.
 * The neutral schema already validates ISO shape; the NaN check is a
 * boundary guard only.
 */
const parseOccurredAt = (payload: {
  occurred_at?: string | undefined;
}): Date | null => {
  if (payload.occurred_at === undefined) {
    return null;
  }
  const parsed = new Date(payload.occurred_at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * A delivery is stale when it is strictly older than the last applied
 * event. Retries invert ordering (each event backs off independently),
 * and applying an old `active` after a newer `revoked` would resurrect
 * a terminated entitlement. Equal or missing timestamps apply as
 * before: idempotent updates are harmless and providers without the
 * field keep delivery-order semantics.
 */
const isStaleProviderEvent = (
  existing: ExistingEntitlement,
  occurredAt: Date | null,
): boolean =>
  occurredAt !== null &&
  existing.hostedLastEventAt !== null &&
  occurredAt < existing.hostedLastEventAt;

const lastEventPatch = (
  existing: ExistingEntitlement,
  occurredAt: Date | null,
): { hostedLastEventAt?: Date } =>
  occurredAt !== null &&
  (existing.hostedLastEventAt === null ||
    occurredAt > existing.hostedLastEventAt)
    ? { hostedLastEventAt: occurredAt }
    : {};

const findEntitlementByHostedExternalId = async (
  tx: Transaction,
  hostedEntitlementExternalId: string,
): Promise<ExistingEntitlement | null> => {
  const rows = await tx
    .select({
      id: usageEntitlements.id,
      organizationId: usageEntitlements.organizationId,
      source: usageEntitlements.source,
      usagePolicyId: usageEntitlements.usagePolicyId,
      hostedLastEventAt: usageEntitlements.hostedLastEventAt,
      seats: usageEntitlements.seats,
      hostedPeakSeats: usageEntitlements.hostedPeakSeats,
      currentPeriodStart: usageEntitlements.currentPeriodStart,
    })
    .from(usageEntitlements)
    .where(
      eq(
        usageEntitlements.hostedEntitlementExternalId,
        hostedEntitlementExternalId,
      ),
    )
    .limit(1)
    // Row lock: concurrent deliveries for one entitlement must
    // serialize, or two seat-increase events can both read the same
    // peak and grant overlapping deltas. The waiter re-reads the row
    // after the winner commits, so it sees the updated peak.
    .for("update");
  return rows.at(0) ?? null;
};

const resolveSeatScopeUserId = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  candidate: string | undefined,
): Promise<string | null> => {
  if (!candidate) {
    return null;
  }
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, candidate),
      ),
    )
    .limit(1);
  return rows.at(0)?.userId ?? null;
};

const findEntitlementByHostedAccountRef = async (
  tx: Transaction,
  hostedAccountRef: string,
): Promise<ExistingEntitlement | null> => {
  const rows = await tx
    .select({
      id: usageEntitlements.id,
      organizationId: usageEntitlements.organizationId,
      source: usageEntitlements.source,
      usagePolicyId: usageEntitlements.usagePolicyId,
      hostedLastEventAt: usageEntitlements.hostedLastEventAt,
      seats: usageEntitlements.seats,
      hostedPeakSeats: usageEntitlements.hostedPeakSeats,
      currentPeriodStart: usageEntitlements.currentPeriodStart,
    })
    .from(usageEntitlements)
    .where(eq(usageEntitlements.hostedAccountRef, hostedAccountRef))
    .limit(1)
    // Same serialization rationale as the external-id finder above.
    .for("update");
  return rows.at(0) ?? null;
};

const HOSTED_PROVIDER_STATUS_MAP: Record<string, UsageEntitlementStatus> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "cancelled",
  unpaid: "past_due",
  incomplete: "trialing",
  incomplete_expired: "cancelled",
  paused: "paused",
};

const mapHostedProviderStatus = (
  providerStatus: string,
): UsageEntitlementStatus =>
  HOSTED_PROVIDER_STATUS_MAP[providerStatus] ?? "past_due";

type HostedEntitlementUpsertParams = {
  tx: Transaction;
  payload: HostedUsageEntitlementPayload;
  eventId: string;
};

export const handleHostedEntitlementUpsert = async ({
  tx,
  payload,
  eventId,
}: HostedEntitlementUpsertParams): Promise<DispatchOutcome> => {
  // metadata.organization_id (which we set at hosted setup creation) is
  // authoritative only before a local mapping exists. Once an entitlement is
  // mapped, the local row owns the org id, so a renewal/update that arrives
  // without metadata must still apply — requiring it up front would silently
  // drop the new period and skip the periodic allocation.
  const metadataOrganizationId = payload.metadata?.organization_id ?? null;

  const policy = await resolvePolicyByHostedPolicyRef(
    tx,
    payload.policy_ref,
    "subscription",
  );
  if (!policy) {
    return {
      kind: "ignored",
      reason: `no subscription usage_policy matches hosted policy reference ${payload.policy_ref}`,
    };
  }

  const status = mapHostedProviderStatus(payload.status);
  const periodStart = new Date(payload.current_period_start);
  const periodEnd = new Date(payload.current_period_end);
  if (
    Number.isNaN(periodStart.getTime()) ||
    Number.isNaN(periodEnd.getTime()) ||
    periodEnd <= periodStart
  ) {
    return { kind: "ignored", reason: "invalid period dates" };
  }

  const seats = payload.quantity ?? 1;
  const occurredAt = parseOccurredAt(payload);
  const existingByProvider = await findEntitlementByHostedExternalId(
    tx,
    payload.id,
  );

  let entitlementId: SafeId<"usageEntitlement">;
  // Ownership resolution: when a local entitlement row already
  // exists, the org id on THAT row is authoritative — the metadata
  // is a hint, not a source of truth (see /conventions-security
  // and the docstring at the top of this file). Only the fresh
  // insert path is allowed to trust metadata, because that's the
  // only signal we have before a local mapping exists.
  let ownerOrganizationId: SafeId<"organization">;
  // Pre-update row state, kept for the seat-increase delta below.
  // Null on the fresh-insert path: the periodic allocation already
  // covers every seat there.
  let previousRow: ExistingEntitlement | null = null;

  if (existingByProvider) {
    if (existingByProvider.source !== "hosted") {
      return {
        kind: "ignored",
        reason: "matching entitlement is manually managed",
      };
    }
    if (isStaleProviderEvent(existingByProvider, occurredAt)) {
      return {
        kind: "ignored",
        reason: "stale provider event (older than last applied event)",
      };
    }
    if (
      metadataOrganizationId !== null &&
      existingByProvider.organizationId !== metadataOrganizationId
    ) {
      // Metadata claims a different org than the row we already have
      // mapped to this provider entitlement. Either hosted setup
      // attached the wrong metadata or the event is otherwise
      // inconsistent. We must not silently move units between orgs.
      // Absent metadata is fine: the local row is authoritative.
      return {
        kind: "ignored",
        reason: "metadata organization_id mismatches local mapping",
      };
    }
    ownerOrganizationId = existingByProvider.organizationId;
    const existingByAccountRef = await findEntitlementByHostedAccountRef(
      tx,
      payload.account_ref,
    );
    if (
      existingByAccountRef &&
      existingByAccountRef.id !== existingByProvider.id
    ) {
      return {
        kind: "ignored",
        reason: "hosted account reference already maps to another entitlement",
      };
    }
    previousRow = existingByProvider;
    await tx
      .update(usageEntitlements)
      .set({
        usagePolicyId: policy.id,
        status,
        seats,
        hostedPeakSeats: nextPeakSeats(existingByProvider, seats, periodStart),
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        hostedAccountRef: payload.account_ref,
        hostedEntitlementExternalId: payload.id,
        cancelAtPeriodEnd: payload.cancel_at_period_end ?? false,
        ...lastEventPatch(existingByProvider, occurredAt),
      })
      .where(eq(usageEntitlements.id, existingByProvider.id));
    await recordWebhookAuditEvent({
      tx,
      organizationId: ownerOrganizationId,
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
      resourceId: existingByProvider.id,
      eventId,
      changes: { provider_event: { old: null, new: eventId } },
    });
    entitlementId = existingByProvider.id;
  } else {
    // Fresh entitlement. Refuse if the org already has a manual
    // entitlement; an operator must resolve the conflict explicitly.
    const existingByAccountRef = await findEntitlementByHostedAccountRef(
      tx,
      payload.account_ref,
    );
    if (existingByAccountRef) {
      if (existingByAccountRef.source === "manual") {
        return {
          kind: "ignored",
          reason: "org has manual entitlement; refuse hosted overwrite",
        };
      }
      if (
        metadataOrganizationId !== null &&
        existingByAccountRef.organizationId !== metadataOrganizationId
      ) {
        return {
          kind: "ignored",
          reason: "metadata organization_id mismatches local account mapping",
        };
      }
      if (isStaleProviderEvent(existingByAccountRef, occurredAt)) {
        return {
          kind: "ignored",
          reason: "stale provider event (older than last applied event)",
        };
      }
      ownerOrganizationId = existingByAccountRef.organizationId;
      previousRow = existingByAccountRef;
      await tx
        .update(usageEntitlements)
        .set({
          usagePolicyId: policy.id,
          status,
          seats,
          hostedPeakSeats: nextPeakSeats(
            existingByAccountRef,
            seats,
            periodStart,
          ),
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          hostedAccountRef: payload.account_ref,
          hostedEntitlementExternalId: payload.id,
          cancelAtPeriodEnd: payload.cancel_at_period_end ?? false,
          ...lastEventPatch(existingByAccountRef, occurredAt),
        })
        .where(eq(usageEntitlements.id, existingByAccountRef.id));
      await recordWebhookAuditEvent({
        tx,
        organizationId: ownerOrganizationId,
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
        resourceId: existingByAccountRef.id,
        eventId,
        changes: { provider_event: { old: null, new: eventId } },
      });
      entitlementId = existingByAccountRef.id;
    } else {
      // Truly fresh: no local mapping exists, so metadata is the only
      // ownership signal we have.
      if (metadataOrganizationId === null) {
        return { kind: "ignored", reason: "missing metadata.organization_id" };
      }
      const organizationId = parseAuthProviderId<"organization">(
        metadataOrganizationId,
      );
      if (organizationId === null) {
        return { kind: "ignored", reason: "invalid metadata.organization_id" };
      }
      ownerOrganizationId = organizationId;
      const inserted = await tx
        .insert(usageEntitlements)
        .values({
          organizationId,
          usagePolicyId: policy.id,
          status,
          seats,
          hostedPeakSeats: seats,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          hostedAccountRef: payload.account_ref,
          hostedEntitlementExternalId: payload.id,
          cancelAtPeriodEnd: payload.cancel_at_period_end ?? false,
          hostedLastEventAt: occurredAt,
          source: "hosted",
        })
        .returning({ id: usageEntitlements.id });

      const insertedId = inserted.at(0)?.id;
      if (!insertedId) {
        panic("usageEntitlements insert returned no rows");
      }
      await recordWebhookAuditEvent({
        tx,
        organizationId: ownerOrganizationId,
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
        resourceId: insertedId,
        eventId,
      });
      // First activation: assign the purchasing member to a seat so
      // the per-user budgets work immediately; further assignments are
      // manager-managed. Membership is validated the same way the
      // add-on attribution is; a stale value simply assigns nobody.
      const purchaserUserId = await resolveSeatScopeUserId(
        tx,
        organizationId,
        payload.metadata?.seat_user_id,
      );
      if (purchaserUserId !== null) {
        await tx
          .insert(usageSeatAssignments)
          .values({ organizationId, userId: purchaserUserId })
          .onConflictDoNothing({
            target: [
              usageSeatAssignments.organizationId,
              usageSeatAssignments.userId,
            ],
          });
      }
      entitlementId = insertedId;
    }
  }

  // Capacity may have shrunk: drop designations beyond the recorded
  // count, keeping the earliest-designated members, under the same
  // per-organization lock the designation endpoints take so a racing
  // designation cannot slip past the new bound.
  await lockAssignmentCapacity(tx, ownerOrganizationId);
  const trimmedAssignments = await trimAssignmentsToCapacity(
    tx,
    ownerOrganizationId,
    seats,
  );
  if (trimmedAssignments > 0) {
    await recordWebhookAuditEvent({
      tx,
      organizationId: ownerOrganizationId,
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: ownerOrganizationId,
      eventId,
      changes: {
        field: { old: null, new: "usageAssignment" },
        removed: { old: null, new: trimmedAssignments },
        seats: { old: null, new: seats },
      },
    });
  }

  // Allocate the period's usage units. Idempotent per entitlement period,
  // not per webhook event id: providers may emit multiple updates inside
  // a single period (status flips, seat changes), each with a
  // fresh event id, and keying idempotency on the event id would
  // mint a second periodic allocation on every one. Keying on the
  // local entitlement id + period start collapses all of those
  // re-emits into a single allocation for the period, even if the
  // hosted external entitlement reference changes during reconfiguration.
  const periodicAllocationSourceRef = `${entitlementId}:${periodStart.toISOString()}`;
  const allocation = await allocateUsage({
    tx,
    organizationId: ownerOrganizationId,
    units: policy.monthlyUsageUnits * seats,
    reason: "periodic",
    sourceType: "hosted_entitlement",
    sourceRef: periodicAllocationSourceRef,
    period: { start: periodStart, end: periodEnd },
  });
  if (allocation.status === "allocated") {
    await recordWebhookAuditEvent({
      tx,
      organizationId: ownerOrganizationId,
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION,
      resourceId: allocation.id,
      eventId,
      changes: {
        units: { old: null, new: policy.monthlyUsageUnits * seats },
        reason: { old: null, new: "periodic" },
      },
    });
  }

  // A mid-period seat increase grants its unit delta immediately,
  // pro-rated by the remaining period fraction — the periodic
  // allocation above is idempotent per period and will not re-fire.
  // The delta keys on the new seat count, so a re-delivered event
  // dedupes, and because it is measured against the period's PEAK,
  // cycling seats down and back up cannot mint the same capacity
  // twice. Seat decreases grant nothing and never claw back units;
  // the lower count simply shapes the next renewal's allocation.
  if (previousRow !== null) {
    const samePeriod =
      previousRow.currentPeriodStart.getTime() === periodStart.getTime();
    const previousPeak = peakSeatsOf(previousRow);
    if (samePeriod && seats > previousPeak) {
      const asOf = occurredAt ?? new Date();
      const periodMs = periodEnd.getTime() - periodStart.getTime();
      const remainingMs = periodEnd.getTime() - asOf.getTime();
      const remainingFraction = Math.min(
        Math.max(remainingMs / periodMs, 0),
        1,
      );
      const deltaUnits = Math.floor(
        policy.monthlyUsageUnits * (seats - previousPeak) * remainingFraction,
      );
      const deltaAllocation = await allocateUsage({
        tx,
        organizationId: ownerOrganizationId,
        units: deltaUnits,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: `${periodicAllocationSourceRef}:seats:${seats}`,
        period: { start: periodStart, end: periodEnd },
      });
      if (deltaAllocation.status === "allocated") {
        await recordWebhookAuditEvent({
          tx,
          organizationId: ownerOrganizationId,
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION,
          resourceId: deltaAllocation.id,
          eventId,
          changes: {
            units: { old: null, new: deltaUnits },
            reason: { old: null, new: "periodic" },
            seats: { old: previousPeak, new: seats },
          },
        });
      }
    }
  }

  return { kind: "applied", entitlementId };
};

type UsageEntitlementStatusUpdateParams = {
  tx: Transaction;
  payload: HostedUsageEntitlementPayload;
  eventId: string;
  /**
   * Distinguishes "scheduled to end at period end" (canceled)
   * from "terminated now" (revoked). The provider emits both with
   * different lifecycle semantics:
   *  - canceled: keep `status = "active"` (or whatever the provider
   *    reports) and flip `cancel_at_period_end = true`. The user
   *    keeps access until `current_period_end`.
   *  - revoked: set `status = "cancelled"` and
   *    `cancel_at_period_end = false`. Access is gone immediately.
   */
  eventKind: "canceled" | "revoked";
};

export const handleUsageEntitlementStatusChange = async ({
  tx,
  payload,
  eventId,
  eventKind,
}: UsageEntitlementStatusUpdateParams): Promise<DispatchOutcome> => {
  const existing = await findEntitlementByHostedExternalId(tx, payload.id);
  if (!existing) {
    return { kind: "ignored", reason: "no matching entitlement row" };
  }
  if (existing.source !== "hosted") {
    return {
      kind: "ignored",
      reason: "entitlement is manually managed",
    };
  }
  const occurredAt = parseOccurredAt(payload);
  if (isStaleProviderEvent(existing, occurredAt)) {
    return {
      kind: "ignored",
      reason: "stale provider event (older than last applied event)",
    };
  }
  const update =
    eventKind === "canceled"
      ? {
          status: mapHostedProviderStatus(payload.status),
          cancelAtPeriodEnd: true,
        }
      : { status: "cancelled" as const, cancelAtPeriodEnd: false };
  await tx
    .update(usageEntitlements)
    .set({ ...update, ...lastEventPatch(existing, occurredAt) })
    .where(eq(usageEntitlements.id, existing.id));
  await recordWebhookAuditEvent({
    tx,
    organizationId: existing.organizationId,
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
    resourceId: existing.id,
    eventId,
    changes: {
      eventKind: { old: null, new: eventKind },
      cancelAtPeriodEnd: { old: null, new: update.cancelAtPeriodEnd },
      status: { old: null, new: update.status },
    },
  });
  return { kind: "applied", entitlementId: existing.id };
};

type HostedAllocationParams = {
  tx: Transaction;
  payload: HostedUsageAllocationPayload;
  eventId: string;
};

export const handleHostedAllocation = async ({
  tx,
  payload,
  eventId,
}: HostedAllocationParams): Promise<DispatchOutcome> => {
  if (payload.allocation_reason !== "addon") {
    return {
      kind: "ignored",
      reason: `allocation_reason ${payload.allocation_reason ?? "missing"} is not an addon allocation`,
    };
  }

  // Addon allocation events must carry the org_id and usage_policy_id we
  // attached at hosted setup creation. Anything missing falls through
  // to ignored; we never invent ownership from account_ref.
  const organizationIdRaw = payload.metadata?.organization_id;
  if (!organizationIdRaw) {
    return { kind: "ignored", reason: "missing metadata.organization_id" };
  }
  const organizationId = parseAuthProviderId<"organization">(organizationIdRaw);
  if (organizationId === null) {
    return { kind: "ignored", reason: "invalid metadata.organization_id" };
  }

  const policy = await resolvePolicyByHostedPolicyRef(
    tx,
    payload.policy_ref,
    "addon",
  );
  if (!policy) {
    return {
      kind: "ignored",
      reason: `no add-on usage_policy matches hosted policy reference ${payload.policy_ref}`,
    };
  }

  // Add-ons attach to the active entitlement period.
  // Without an entitlement the org has no period to attribute the
  // allocation to; surface as ignored rather than synthesise one.
  const existing = await findEntitlementByHostedAccountRef(
    tx,
    payload.account_ref,
  );
  if (!existing) {
    return {
      kind: "ignored",
      reason: "add-on has no associated entitlement",
    };
  }
  // Ownership: the metadata-supplied org id must match the locally
  // mapped entitlement's org. A mismatch means hosted setup metadata
  // or event mapping is inconsistent; in either case we
  // refuse the allocation rather than silently moving units.
  if (existing.organizationId !== organizationId) {
    return {
      kind: "ignored",
      reason: "metadata organization_id mismatches local mapping",
    };
  }

  const periodRows = await tx
    .select({
      currentPeriodStart: usageEntitlements.currentPeriodStart,
      currentPeriodEnd: usageEntitlements.currentPeriodEnd,
    })
    .from(usageEntitlements)
    .where(eq(usageEntitlements.id, existing.id))
    .limit(1);
  const period = periodRows.at(0);
  if (!period) {
    return { kind: "ignored", reason: "entitlement row vanished" };
  }

  // metadata.seat_user_id is the Stella user.id of the seat that
  // initiated hosted setup; recorded on the ledger row so future
  // per-seat reporting can attribute the allocation. We
  // verify the user is actually a member of the org before
  // writing it; a stale or wrong value (e.g. user left the org
  // between hosted setup and webhook delivery) falls back to org pool
  // attribution rather than poisoning the audit trail.
  const seatScopeUserId = await resolveSeatScopeUserId(
    tx,
    organizationId,
    payload.metadata?.seat_user_id,
  );

  const allocationResult = await allocateUsage({
    tx,
    organizationId,
    units: policy.monthlyUsageUnits,
    reason: "addon",
    sourceType: "hosted_allocation",
    sourceRef: eventId,
    seatScopeUserId,
    period: {
      start: period.currentPeriodStart,
      end: period.currentPeriodEnd,
    },
  });

  if (allocationResult.status === "duplicate") {
    return { kind: "duplicate_allocation" };
  }
  if (allocationResult.status === "skipped") {
    return { kind: "ignored", reason: "policy grants zero add-on units" };
  }

  await recordWebhookAuditEvent({
    tx,
    organizationId,
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION,
    resourceId: allocationResult.id,
    eventId,
    changes: {
      units: { old: null, new: policy.monthlyUsageUnits },
      reason: { old: null, new: "addon" },
      seatScopeUserId: { old: null, new: seatScopeUserId },
    },
  });

  return { kind: "applied", entitlementId: existing.id };
};
