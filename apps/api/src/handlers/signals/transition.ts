import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import type { SignalStatus } from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import { SIGNAL_EVENT_TYPE, signalEvents, signals } from "@/api/db/schema";
import type { SignalAcceptedResult, SignalEventType } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log.constants";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

export const canTriageSignals = (memberRole: AuthorizedMemberRole): boolean =>
  hasMemberPermission(memberRole, { signal: ["triage"] });

export type SignalTransitionArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  signalId: SafeId<"signal">;
  actorUserId: SafeId<"user">;
  /** Statuses the row must currently be in; the UPDATE's WHERE closes the race. */
  from: readonly SignalStatus[];
  set: Partial<{
    status: SignalStatus;
    snoozedUntil: Date | null;
    assigneeUserId: SafeId<"user"> | null;
    dismissReason: string | null;
    acceptedResult: SignalAcceptedResult | null;
    resolvedAt: Date | null;
  }>;
  event: { type: SignalEventType; payload?: Record<string, unknown> };
  /** Audit row written in the same transaction as the transition. */
  audit: {
    recordAuditEvent: AuditRecorder;
    workspaceId: SafeId<"workspace"> | null;
    previousStatus: SignalStatus;
    metadata: Record<string, unknown>;
  };
};

/**
 * Conditional state transition plus its audit event, in one transaction.
 * Returns a 409 when the row was no longer in an allowed `from` state.
 */
export const transitionSignal = async ({
  tx,
  organizationId,
  signalId,
  actorUserId,
  from,
  set,
  event,
  audit,
}: SignalTransitionArgs) => {
  const updated = await tx
    .update(signals)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(signals.id, signalId),
        eq(signals.organizationId, organizationId),
        inArray(signals.status, [...from]),
      ),
    )
    .returning({ id: signals.id });
  if (updated.length === 0) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Signal is no longer in a state that allows this action",
      }),
    );
  }
  await tx.insert(signalEvents).values({
    id: createSafeId<"signalEvent">(),
    organizationId,
    signalId,
    type: event.type,
    actorUserId,
    payload: event.payload ?? null,
  });
  await audit.recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.SIGNAL,
    resourceId: signalId,
    workspaceId: audit.workspaceId,
    changes: {
      status: {
        old: audit.previousStatus,
        new: set.status ?? audit.previousStatus,
      },
    },
    metadata: { ...audit.metadata, event: event.type },
  });
  return Result.ok(undefined);
};

export { SIGNAL_EVENT_TYPE };
