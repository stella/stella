/**
 * Operator grants of manually managed plans: complimentary access, or a
 * customer paying outside the hosted checkout. A manual entitlement resolves
 * to paid access by its `manual` source (`readOrganizationAccessSnapshot`)
 * and binds its policy's limits (`organization_effective_policy`) until its
 * `current_period_end`; nothing here writes the lifecycle `status`, which
 * stays with the hosted provider's events.
 */

import { panic, Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { usageEntitlements, usagePolicies } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import {
  checkMemberCapacityChange,
  memberCapacityOf,
} from "@/api/lib/usage/member-capacity";

export class ManualEntitlementRefusedError extends TaggedError(
  "ManualEntitlementRefusedError",
)<{ message: string }> {}

const refused = (message: string) =>
  Result.err(new ManualEntitlementRefusedError({ message }));

const MANUAL_ENTITLEMENT_AUDIT_SOURCE = "manual-entitlement";

type ManualEntitlementActor = {
  actor: string;
  reason: string;
};

// The recorder is created inside each writing function, where the audit
// lint rule looks for it; only its options are shared.
const auditRecorderOptions = ({
  organizationId,
  actor,
}: {
  organizationId: SafeId<"organization">;
  actor: string;
}): Parameters<typeof createBackgroundAuditRecorder>[0] => ({
  organizationId,
  workspaceId: null,
  userId: actor,
  execution: {
    performer: { type: "service", id: actor, name: actor },
    trigger: { type: "system", source: MANUAL_ENTITLEMENT_AUDIT_SOURCE },
  },
});

const lockOrganization = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  const lock = await withAggregateLock({
    aggregate: "organization",
    id: organizationId,
    mode: "update",
    tx,
  });
  switch (lock.status) {
    case "locked":
      return Result.ok(undefined);
    case "missing":
      return refused("The organization does not exist");
    case "busy":
      // Only a `nowait` acquisition reports busy; this one blocks.
      return panic("A blocking organization lock reported busy");
    default:
      lock satisfies never;
      return panic("Unhandled aggregate lock status");
  }
};

const readEntitlement = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) =>
  await tx
    .select()
    .from(usageEntitlements)
    .where(eq(usageEntitlements.organizationId, organizationId))
    .limit(1)
    .then((rows) => rows.at(0));

type GrantManualEntitlementOptions = ManualEntitlementActor & {
  organizationId: SafeId<"organization">;
  usagePolicyId: SafeId<"usagePolicy">;
  seats: number;
  periodEndsAt: Date;
};

/**
 * Grants a manual plan until `periodEndsAt`, or renews the organization's
 * existing manual one with new terms. Refused over a hosted entitlement in
 * any status, for a policy that is not a subscription with a service-action
 * budget, and when the seats would drop below the current members.
 */
export const grantManualEntitlement = async (
  tx: Transaction,
  {
    organizationId,
    usagePolicyId,
    seats,
    periodEndsAt,
    actor,
    reason,
  }: GrantManualEntitlementOptions,
) => {
  const now = new Date();
  if (periodEndsAt <= now) {
    return refused("The period must end in the future");
  }
  // The organization row lock serializes operator changes for one
  // organization; the unique index on `organization_id` arbitrates against a
  // concurrent hosted first entitlement, so this insert can never replace one.
  const locked = await lockOrganization(tx, organizationId);
  if (Result.isError(locked)) {
    return locked;
  }
  const existing = await readEntitlement(tx, organizationId);
  if (existing?.source === "hosted") {
    return refused(
      "The organization has a hosted entitlement; manage it through the hosted provider",
    );
  }
  const policy = await tx
    .select({
      kind: usagePolicies.kind,
      maxMembers: usagePolicies.maxMembers,
      priceBasis: usagePolicies.priceBasis,
      serviceActionsPerPeriod: usagePolicies.serviceActionsPerPeriod,
    })
    .from(usagePolicies)
    .where(eq(usagePolicies.id, usagePolicyId))
    .limit(1)
    .then((rows) => rows.at(0));
  if (policy === undefined) {
    return refused("The usage policy does not exist");
  }
  if (
    policy.kind !== "subscription" ||
    policy.serviceActionsPerPeriod === null
  ) {
    return refused(
      "Manual entitlements require a subscription policy with a service-action budget",
    );
  }
  const capacity = await checkMemberCapacityChange(tx, {
    organizationId,
    nextCapacity: memberCapacityOf({
      maxMembers: policy.maxMembers,
      priceBasis: policy.priceBasis,
      seats,
    }),
  });
  if (Result.isError(capacity)) {
    return refused(capacity.error.message);
  }
  const recordAuditEvent = createBackgroundAuditRecorder(
    auditRecorderOptions({ organizationId, actor }),
  );
  if (existing === undefined) {
    const inserted = await tx
      .insert(usageEntitlements)
      .values({
        id: createSafeId<"usageEntitlement">(),
        organizationId,
        usagePolicyId,
        status: "active",
        seats,
        currentPeriodStart: now,
        currentPeriodEnd: periodEndsAt,
        source: "manual",
      })
      .returning()
      .then((rows) => rows.at(0));
    if (inserted === undefined) {
      return refused("The manual entitlement could not be recorded");
    }
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
      resourceId: inserted.id,
      changes: {
        usagePolicyId: { old: null, new: usagePolicyId },
        seats: { old: null, new: seats },
        currentPeriodEnd: { old: null, new: periodEndsAt },
        reason: { old: null, new: reason },
      },
    });
    return Result.ok(inserted);
  }
  const renewed = await tx
    .update(usageEntitlements)
    .set({
      usagePolicyId,
      seats,
      currentPeriodStart: now,
      currentPeriodEnd: periodEndsAt,
      cancelAtPeriodEnd: false,
    })
    .where(eq(usageEntitlements.id, existing.id))
    .returning()
    .then((rows) => rows.at(0));
  if (renewed === undefined) {
    return refused("The manual entitlement could not be renewed");
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
    resourceId: renewed.id,
    changes: {
      usagePolicyId: { old: existing.usagePolicyId, new: usagePolicyId },
      seats: { old: existing.seats, new: seats },
      currentPeriodEnd: { old: existing.currentPeriodEnd, new: periodEndsAt },
      reason: { old: null, new: reason },
    },
  });
  return Result.ok(renewed);
};

type EndManualEntitlementOptions = ManualEntitlementActor & {
  organizationId: SafeId<"organization">;
  endsAt: Date;
};

/**
 * Ends the organization's manual plan at `endsAt`, or now when `endsAt` has
 * already passed (an operator's "now" is behind the clock by the time the
 * transaction runs), so the recorded end is never backdated. Ending can only
 * shorten the period, never extend or revive it; a hosted entitlement is
 * refused.
 */
export const endManualEntitlement = async (
  tx: Transaction,
  { organizationId, endsAt, actor, reason }: EndManualEntitlementOptions,
) => {
  const locked = await lockOrganization(tx, organizationId);
  if (Result.isError(locked)) {
    return locked;
  }
  const entitlement = await readEntitlement(tx, organizationId);
  if (entitlement === undefined) {
    return refused("The organization has no entitlement to end");
  }
  if (entitlement.source === "hosted") {
    return refused(
      "Hosted entitlements must be ended through the hosted provider",
    );
  }
  const now = new Date();
  if (entitlement.currentPeriodEnd <= now) {
    return refused("The manual entitlement has already ended");
  }
  const effectiveEnd = endsAt < now ? now : endsAt;
  if (effectiveEnd > entitlement.currentPeriodEnd) {
    return refused(
      "Ending cannot extend the period; grant again to renew instead",
    );
  }
  if (effectiveEnd <= entitlement.currentPeriodStart) {
    return refused("The end must fall after the period start");
  }
  const updated = await tx
    .update(usageEntitlements)
    .set({ currentPeriodEnd: effectiveEnd, cancelAtPeriodEnd: true })
    .where(eq(usageEntitlements.id, entitlement.id))
    .returning()
    .then((rows) => rows.at(0));
  if (updated === undefined) {
    return refused("The manual entitlement could not be ended");
  }
  const recordAuditEvent = createBackgroundAuditRecorder(
    auditRecorderOptions({ organizationId, actor }),
  );
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CANCEL,
    resourceType: AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
    resourceId: updated.id,
    changes: {
      currentPeriodEnd: {
        old: entitlement.currentPeriodEnd,
        new: effectiveEnd,
      },
      reason: { old: null, new: reason },
    },
  });
  return Result.ok(updated);
};
