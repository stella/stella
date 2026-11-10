import { and, eq } from "drizzle-orm";

import { CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS } from "@stll/api-contract/chat-run-target";
import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

/** A settings row's ceiling; every mode for an organization without one. */
export const localRunApprovalCeilingOf = (
  row:
    { localRunMaxApprovalMode: DesktopRunnerApprovalMode } | null | undefined,
): DesktopRunnerApprovalMode =>
  row?.localRunMaxApprovalMode ?? CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS;

/**
 * The most the organization lets a chat turn on a member's computer do
 * without asking, as stored now. An organization that never saved settings
 * allows every mode.
 */
export const readLocalRunApprovalCeiling = async (
  safeDb: SafeDb,
  organizationId: SafeId<"organization">,
) =>
  (
    await safeDb(
      async (tx) =>
        await tx
          .select({
            localRunMaxApprovalMode:
              organizationSettings.localRunMaxApprovalMode,
          })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId))
          .limit(1),
    )
  ).map((rows) => localRunApprovalCeilingOf(rows.at(0)));

type UpdateLocalRunApprovalCeilingOptions = {
  organizationId: SafeId<"organization">;
  maxApprovals: DesktopRunnerApprovalMode;
  recordAuditEvent: AuditRecorder;
};

/**
 * Set the organization's ceiling and audit the change with the value it
 * replaced. The write only lands on the value it read, so of two
 * administrators saving at once the later one is told the setting changed
 * rather than recording a replaced value it never saw. Turns already running
 * keep the mode they started with; the next turn is held to the new ceiling.
 */
export const updateLocalRunApprovalCeiling = async (
  tx: Transaction,
  {
    organizationId,
    maxApprovals,
    recordAuditEvent,
  }: UpdateLocalRunApprovalCeilingOptions,
) => {
  await tx
    .insert(organizationSettings)
    .values({ id: createSafeId<"organizationSettings">(), organizationId })
    .onConflictDoNothing({ target: organizationSettings.organizationId });
  const previous = localRunApprovalCeilingOf(
    (
      await tx
        .select({
          localRunMaxApprovalMode: organizationSettings.localRunMaxApprovalMode,
        })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId))
        .limit(1)
    ).at(0),
  );
  if (previous === maxApprovals) {
    return { type: "updated", maxApprovals } as const;
  }
  const written = await tx
    .update(organizationSettings)
    .set({ localRunMaxApprovalMode: maxApprovals, updatedAt: new Date() })
    .where(
      and(
        eq(organizationSettings.organizationId, organizationId),
        eq(organizationSettings.localRunMaxApprovalMode, previous),
      ),
    )
    .returning({ id: organizationSettings.id });
  if (written.length === 0) {
    return { type: "changed" } as const;
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
    resourceId: organizationId,
    changes: {
      localRunMaxApprovalMode: { old: previous, new: maxApprovals },
    },
  });
  return { type: "updated", maxApprovals } as const;
};
