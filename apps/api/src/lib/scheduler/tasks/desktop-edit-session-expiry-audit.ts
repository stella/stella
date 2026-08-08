import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditEvent,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

export type ExpirableSession = {
  id: string;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  createdBy: string;
};

export type ExpiryAuditEvent = {
  organizationId: SafeId<"organization">;
  userId: string;
  event: AuditEvent;
};

export const selectTransitionedExpirableSessions = <
  TSession extends { id: string },
>(
  sessions: readonly TSession[],
  transitionedIds: ReadonlySet<string>,
): TSession[] => sessions.filter((session) => transitionedIds.has(session.id));

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
  selectTransitionedExpirableSessions(sessions, expiredIds).map((session) => ({
    organizationId: session.organizationId,
    userId: session.createdBy,
    event: {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
      resourceId: session.id,
      workspaceId: session.workspaceId,
      changes: { status: { old: "open", new: "expired" } },
      metadata: { reason: "token_expired" },
    },
  }));
