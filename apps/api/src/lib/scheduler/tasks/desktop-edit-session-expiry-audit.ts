import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

export type ExpirableSession = {
  id: string;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  createdBy: string;
};

export type ExpiryAuditEvent = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: string;
  action: typeof AUDIT_ACTION.UPDATE;
  resourceType: typeof AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION;
  resourceId: string;
  changes: { status: { old: "open"; new: "expired" } };
  metadata: { reason: "token_expired" };
};

/**
 * A row selected as expirable can drop out before the UPDATE commits: a
 * concurrent finalize or takeover leaves "open", or a checkpoint/resume
 * renews tokenExpiresAt. The ids the UPDATE actually transitioned are the
 * source of truth for what to audit, not the originally selected batch.
 */
export const buildExpiryAuditEvents = (
  sessions: readonly ExpirableSession[],
  expiredIds: ReadonlySet<string>,
): ExpiryAuditEvent[] =>
  sessions
    .filter((session) => expiredIds.has(session.id))
    .map((session) => ({
      organizationId: session.organizationId,
      workspaceId: session.workspaceId,
      userId: session.createdBy,
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
      resourceId: session.id,
      changes: { status: { old: "open", new: "expired" } },
      metadata: { reason: "token_expired" },
    }));
