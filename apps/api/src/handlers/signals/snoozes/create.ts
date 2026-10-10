import { Result } from "better-result";

import { SIGNAL_STATUS } from "@stll/api-contract/signals";
import { Temporal } from "@stll/time";

import { resultTx } from "@/api/db/safe-db";
import {
  signalParamsSchema,
  snoozeBodySchema,
} from "@/api/handlers/signals/schema";
import {
  SIGNAL_EVENT_TYPE,
  transitionSignal,
} from "@/api/handlers/signals/transition";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withVisibleSignal } from "@/api/lib/signals/proofs/signal-visible-to";
import {
  canTriageSignals,
  loadVisibleSignal,
  serializeSignal,
} from "@/api/lib/signals/read";

const config = {
  description:
    "Snooze an inbox signal until a later time; it returns to the open feed " +
    "once that time passes.",
  permissions: { signal: ["resolve"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
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
    if (until.getTime() <= Temporal.Now.instant().epochMilliseconds) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Snooze time must be in the future",
        }),
      );
    }
    yield* Result.await(
      resultTx(safeDb, async (transaction) =>
        withVisibleSignal(
          {
            tx: transaction,
            organizationId,
            actorUserId: user.id,
            memberRole,
            signalId: params.signalId,
          },
          async ({ tx, signal, actor, proof, existing }) =>
            await transitionSignal({
              tx,
              visibility: proof,
              signalId: signal,
              actorUserId: actor,
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
      ),
    );
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
