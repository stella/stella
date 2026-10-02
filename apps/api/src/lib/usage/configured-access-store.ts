import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  organizationConfiguredAccess,
  usageEntitlements,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  transitionConfiguredAccess,
  type ConfiguredAccessEvent,
} from "@/api/lib/usage/configured-access";
import {
  configuredAccessSourceMatches,
  decodeConfiguredAccess,
  readOriginalOrganizationAccessSnapshot,
} from "@/api/lib/usage/organization-access-snapshot";

type ApplyConfiguredAccessEventOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  event: ConfiguredAccessEvent;
  mapping: "current" | "replacement";
  previousSource: Pick<
    typeof usageEntitlements.$inferSelect,
    "status" | "cancelAtPeriodEnd" | "hostedLastEventAt"
  > | null;
};

// Called only after the dispatcher has locked and accepted the current mapping;
// its enclosing transaction records the webhook audit and rolls both states back.
export const applyConfiguredAccessEvent = async ({
  tx,
  organizationId,
  event,
  mapping,
  previousSource,
}: ApplyConfiguredAccessEventOptions) => {
  const row = await tx
    .select()
    .from(organizationConfiguredAccess)
    .where(eq(organizationConfiguredAccess.organizationId, organizationId))
    .limit(1)
    .for("update")
    .then((rows) => rows.at(0));
  const source = await tx
    .select()
    .from(usageEntitlements)
    .where(eq(usageEntitlements.organizationId, organizationId))
    .limit(1)
    .then((rows) => rows.at(0) ?? panic("Configured access source is missing"));
  const original = await readOriginalOrganizationAccessSnapshot(
    tx,
    organizationId,
  );
  const sourceSignature = JSON.stringify(original ?? null);
  const sourceEventAt = source.hostedLastEventAt;
  const current =
    mapping === "current" &&
    row !== undefined &&
    previousSource !== null &&
    !(
      previousSource.status === "cancelled" && !previousSource.cancelAtPeriodEnd
    ) &&
    configuredAccessSourceMatches({
      configured: row,
      original,
      source: previousSource,
    })
      ? decodeConfiguredAccess(row)
      : null;
  const access = transitionConfiguredAccess(current, event);
  if (
    row !== undefined &&
    JSON.stringify(decodeConfiguredAccess(row)) === JSON.stringify(access) &&
    row?.sourceSignature === sourceSignature &&
    row.sourceEntitlementStatus === source.status &&
    row.sourceCancelAtPeriodEnd === source.cancelAtPeriodEnd &&
    row.sourceEventAt?.getTime() === sourceEventAt?.getTime()
  ) {
    return;
  }
  const values = {
    organizationId,
    sourceSignature,
    sourceEventAt,
    sourceEntitlementStatus: source.status,
    sourceCancelAtPeriodEnd: source.cancelAtPeriodEnd,
    configuredAccessStatus: access.status,
    configuredPeriodEndsAt:
      access.status === "disabled" ? null : access.periodEndsAt,
    paymentRetryEndsAt:
      access.status === "payment_retry" ? access.retryEndsAt : null,
    serviceActionsPerPeriod:
      access.status === "disabled" ? null : access.serviceActionsPerPeriod,
  };
  await tx
    .insert(organizationConfiguredAccess)
    .values(values)
    .onConflictDoUpdate({
      target: organizationConfiguredAccess.organizationId,
      set: values,
    });
};
