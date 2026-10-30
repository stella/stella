import { panic } from "better-result";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { organizationSettings } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

const readPolicyRow = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) =>
  (
    await tx
      .select({
        sharepointConnectionEnabled:
          organizationSettings.sharepointConnectionEnabled,
        microsoft365CalendarReadEnabled:
          organizationSettings.microsoft365CalendarReadEnabled,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
  ).at(0);

// The optional settings row is also the fence for older API tasks, which
// update it without taking an advisory lock. Ensure it exists before the
// locked read: SELECT FOR UPDATE alone cannot serialize first-time writers.
export const lockSharepointPolicy = async ({
  tx,
  organizationId,
  recordAuditEvent,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
}) => {
  const created = await tx
    .insert(organizationSettings)
    .values({ id: createSafeId<"organizationSettings">(), organizationId })
    .onConflictDoNothing({ target: organizationSettings.organizationId })
    .returning({ id: organizationSettings.id });

  const lock = await withAggregateLock({
    aggregate: "sharepointPolicy",
    id: organizationId,
    mode: "update",
    tx,
  });
  if (lock.status !== "locked") {
    return panic("SharePoint policy row missing after creation");
  }
  const policy = await readPolicyRow(tx, organizationId);
  if (created.length > 0) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
      resourceId: organizationId,
      workspaceId: null,
      metadata: { operation: "sharepoint_policy_row_created" },
    });
  }

  if (!policy) {
    return panic("SharePoint policy row missing after creation");
  }
  return policy;
};

export const readLockedSharepointPolicy = async ({
  tx,
  organizationId,
  mode,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  mode: "share" | "update";
}) => {
  const lock = await withAggregateLock({
    aggregate: "sharepointPolicy",
    id: organizationId,
    mode,
    tx,
  });
  if (lock.status === "missing") {
    return null;
  }
  if (lock.status !== "locked") {
    return panic("Blocking SharePoint policy acquisition returned busy");
  }
  return (
    (await readPolicyRow(tx, organizationId)) ??
    panic("Locked SharePoint policy row disappeared")
  );
};
