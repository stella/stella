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

import type { Transaction } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import { usagePolicies, usageEntitlements } from "@/api/db/schema";
import type { UsageEntitlementStatus } from "@/api/db/schema";
import type {
  HostedUsageAllocationPayload,
  HostedUsageEntitlementPayload,
} from "@/api/handlers/hosted-usage-webhook/event-schemas";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { recordWebhookAuditEvent } from "@/api/lib/hosted-usage-provider/webhook-store";
import { allocateUsage } from "@/api/lib/usage";

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
): Promise<PolicyLookup | null> => {
  const rows = await tx
    .select({
      id: usagePolicies.id,
      monthlyUsageUnits: usagePolicies.monthlyUsageUnits,
    })
    .from(usagePolicies)
    .where(eq(usagePolicies.hostedPolicyRef, hostedPolicyRef))
    .limit(1);
  return rows.at(0) ?? null;
};

type ExistingEntitlement = {
  id: SafeId<"usageEntitlement">;
  organizationId: SafeId<"organization">;
  source: "hosted" | "manual";
  usagePolicyId: SafeId<"usagePolicy">;
};

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
    })
    .from(usageEntitlements)
    .where(
      eq(
        usageEntitlements.hostedEntitlementExternalId,
        hostedEntitlementExternalId,
      ),
    )
    .limit(1);
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
    })
    .from(usageEntitlements)
    .where(eq(usageEntitlements.hostedAccountRef, hostedAccountRef))
    .limit(1);
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

  const policy = await resolvePolicyByHostedPolicyRef(tx, payload.policy_ref);
  if (!policy) {
    return {
      kind: "ignored",
      reason: `no usage_policy matches hosted policy reference ${payload.policy_ref}`,
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

  if (existingByProvider) {
    if (existingByProvider.source !== "hosted") {
      return {
        kind: "ignored",
        reason: "matching entitlement is manually managed",
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
    await tx
      .update(usageEntitlements)
      .set({
        usagePolicyId: policy.id,
        status,
        seats,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        hostedAccountRef: payload.account_ref,
        hostedEntitlementExternalId: payload.id,
        cancelAtPeriodEnd: payload.cancel_at_period_end ?? false,
      })
      .where(eq(usageEntitlements.id, existingByProvider.id));
    await recordWebhookAuditEvent({
      tx,
      organizationId: ownerOrganizationId,
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
      resourceId: existingByProvider.id,
      eventId,
      changes: { provider_event: { new: eventId } },
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
      ownerOrganizationId = existingByAccountRef.organizationId;
      await tx
        .update(usageEntitlements)
        .set({
          usagePolicyId: policy.id,
          status,
          seats,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          hostedAccountRef: payload.account_ref,
          hostedEntitlementExternalId: payload.id,
          cancelAtPeriodEnd: payload.cancel_at_period_end ?? false,
        })
        .where(eq(usageEntitlements.id, existingByAccountRef.id));
      await recordWebhookAuditEvent({
        tx,
        organizationId: ownerOrganizationId,
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
        resourceId: existingByAccountRef.id,
        eventId,
        changes: { provider_event: { new: eventId } },
      });
      entitlementId = existingByAccountRef.id;
    } else {
      // Truly fresh: no local mapping exists, so metadata is the only
      // ownership signal we have.
      if (metadataOrganizationId === null) {
        return { kind: "ignored", reason: "missing metadata.organization_id" };
      }
      // SAFETY: organization_id reaches us via provider metadata that we
      // ourselves set at hosted setup creation (create-hosted-setup.ts pulls
      // it from ctx.session.activeOrganizationId). The webhook signature we
      // verified covers the whole body including metadata, so this value is
      // what we wrote. The FK on usage_entitlements.organization_id rejects a
      // malformed value on insert rather than attaching to a non-existent org.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      const organizationId = metadataOrganizationId as SafeId<"organization">;
      ownerOrganizationId = organizationId;
      const inserted = await tx
        .insert(usageEntitlements)
        .values({
          organizationId,
          usagePolicyId: policy.id,
          status,
          seats,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          hostedAccountRef: payload.account_ref,
          hostedEntitlementExternalId: payload.id,
          cancelAtPeriodEnd: payload.cancel_at_period_end ?? false,
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
      entitlementId = insertedId;
    }
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
  const update =
    eventKind === "canceled"
      ? {
          status: mapHostedProviderStatus(payload.status),
          cancelAtPeriodEnd: true,
        }
      : { status: "cancelled" as const, cancelAtPeriodEnd: false };
  await tx
    .update(usageEntitlements)
    .set(update)
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
  // SAFETY: organization_id reaches us via provider metadata that we
  // ourselves set at hosted setup creation (create-hosted-setup.ts pulls it
  // from ctx.session.activeOrganizationId). The webhook signature
  // we verified covers the whole body including metadata, so this
  // value is what we wrote. The FK
  // on usage_allocations.organization_id is the last line of defence:
  // a malformed value rejects on insert rather than silently
  // attributing units to a non-existent org.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  const organizationId = organizationIdRaw as SafeId<"organization">;

  const policy = await resolvePolicyByHostedPolicyRef(tx, payload.policy_ref);
  if (!policy) {
    return {
      kind: "ignored",
      reason: `no usage_policy matches hosted policy reference ${payload.policy_ref}`,
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
