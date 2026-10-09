import { Result } from "better-result";

import { SIGNAL_STATUS } from "@stll/api-contract/signals";

import { resultTx } from "@/api/db/safe-db";
import {
  dismissBodySchema,
  signalParamsSchema,
} from "@/api/handlers/signals/schema";
import {
  SIGNAL_EVENT_TYPE,
  transitionSignal,
} from "@/api/handlers/signals/transition";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { withVisibleSignal } from "@/api/lib/signals/proofs/signal-visible-to";
import {
  canTriageSignals,
  loadVisibleSignal,
  serializeSignal,
} from "@/api/lib/signals/read";

const config = {
  description:
    "Dismiss an inbox signal with an optional reason; the reason is kept " +
    "for tuning the producer that emitted it.",
  permissions: { signal: ["resolve"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
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
    const reason = body.reason?.trim() || null;
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
          async ({ tx, signal, actor, proof, existing }) => {
            const result = await transitionSignal({
              tx,
              visibility: proof,
              signalId: signal,
              actorUserId: actor,
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
          },
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

export default dismissSignal;
