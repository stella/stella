import { Result } from "better-result";

import { SIGNAL_STATUS } from "@stll/api-contract/signals";

import {
  loadVisibleSignal,
  serializeSignal,
} from "@/api/handlers/signals/read";
import {
  signalParamsSchema,
  snoozeBodySchema,
} from "@/api/handlers/signals/schema";
import {
  canTriageSignals,
  SIGNAL_EVENT_TYPE,
  transitionSignal,
} from "@/api/handlers/signals/transition";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Snooze an inbox signal until a later time; it returns to the open feed " +
    "once that time passes.",
  permissions: { signal: ["resolve"] },
  access: "write",
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: signalParamsSchema,
  body: snoozeBodySchema,
} satisfies HandlerConfig;

const snoozeSignal = createSafeRootHandler(
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
    const until = new Date(body.until);
    if (until.getTime() <= Date.now()) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Snooze time must be in the future",
        }),
      );
    }
    const existing = yield* yield* loadVisibleSignal({
      safeDb,
      organizationId,
      canTriage,
      signalId: params.signalId,
    });
    const transition = yield* Result.await(
      safeDb(
        async (tx) =>
          await transitionSignal({
            tx,
            organizationId,
            signalId: params.signalId,
            actorUserId: user.id,
            from: [SIGNAL_STATUS.NEW, SIGNAL_STATUS.SNOOZED],
            set: { status: SIGNAL_STATUS.SNOOZED, snoozedUntil: until },
            event: {
              type: SIGNAL_EVENT_TYPE.SNOOZED,
              payload: { until: until.toISOString() },
            },
            audit: {
              recordAuditEvent,
              workspaceId: existing.workspaceId,
              previousStatus: existing.status,
              metadata: { kind: existing.kind, scoutKey: existing.scoutKey },
            },
          }),
      ),
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

export default snoozeSignal;
