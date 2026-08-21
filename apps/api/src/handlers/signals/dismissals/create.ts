import { Result } from "better-result";

import { SIGNAL_STATUS } from "@stll/api-contract/signals";

import {
  loadVisibleSignal,
  serializeSignal,
} from "@/api/handlers/signals/read";
import {
  dismissBodySchema,
  signalParamsSchema,
} from "@/api/handlers/signals/schema";
import {
  canTriageSignals,
  SIGNAL_EVENT_TYPE,
  transitionSignal,
} from "@/api/handlers/signals/transition";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "Dismiss an inbox signal with an optional reason; the reason is kept " +
    "for tuning the producer that emitted it.",
  permissions: { signal: ["resolve"] },
  access: "write",
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: signalParamsSchema,
  body: dismissBodySchema,
} satisfies HandlerConfig;

const dismissSignal = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    params,
    body,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;
    const canTriage = canTriageSignals(memberRole);
    const existing = yield* yield* loadVisibleSignal({
      safeDb,
      organizationId,
      canTriage,
      signalId: params.signalId,
    });
    const reason = body.reason?.trim() || null;
    const transition = yield* Result.await(
      safeDb(async (tx) => {
        const result = await transitionSignal({
          tx,
          organizationId,
          signalId: params.signalId,
          actorUserId: user.id,
          from: [SIGNAL_STATUS.NEW, SIGNAL_STATUS.SNOOZED],
          set: {
            status: SIGNAL_STATUS.DISMISSED,
            dismissReason: reason,
            snoozedUntil: null,
            resolvedAt: new Date(),
          },
          event: { type: SIGNAL_EVENT_TYPE.DISMISSED, payload: { reason } },
          audit: {
            recordAuditEvent,
            workspaceId: existing.workspaceId,
            previousStatus: existing.status,
            metadata: { kind: existing.kind, scoutKey: existing.scoutKey },
          },
        });
        return result;
      }),
    );
    yield* transition;
    const row = yield* yield* loadVisibleSignal({
      safeDb,
      organizationId,
      canTriage,
      signalId: params.signalId,
    });
    return Result.ok(serializeSignal(row));
  },
);

export default dismissSignal;
