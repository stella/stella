import { Result } from "better-result";

import { SIGNAL_STATUS } from "@stll/api-contract/signals";

import { resultTx } from "@/api/db/safe-db";
import {
  assignBodySchema,
  signalParamsSchema,
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
import { lockOrgUserIdsForAssignment } from "@/api/lib/validated-org-user-id";

const config = {
  description:
    "Assign an open inbox signal to an organization member, or clear the " +
    "assignment with null.",
  permissions: { signal: ["resolve"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  params: signalParamsSchema,
  body: assignBodySchema,
} satisfies HandlerConfig;

const assignSignal = createSafeRootHandler(
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
    const assigneeUserId = body.assigneeUserId;

    yield* Result.await(
      resultTx(safeDb, (transaction) =>
        withVisibleSignal(
          {
            tx: transaction,
            organizationId,
            actorUserId: user.id,
            memberRole,
            signalId: params.signalId,
          },
          async ({ tx, signal, actor, proof, existing }) => {
            if (assigneeUserId) {
              const orgMember = await lockOrgUserIdsForAssignment({
                tx: tx.value,
                userIds: [assigneeUserId],
                organizationId,
              });
              if (!orgMember) {
                return Result.err(
                  new HandlerError({
                    status: 400,
                    message: "Assignee is not a member of this organization",
                  }),
                );
              }
            }

            return await transitionSignal({
              tx,
              visibility: proof,
              signalId: signal,
              actorUserId: actor,
              from: [SIGNAL_STATUS.NEW, SIGNAL_STATUS.SNOOZED],
              set: { assigneeUserId: body.assigneeUserId },
              event: {
                type: SIGNAL_EVENT_TYPE.ASSIGNED,
                payload: { assigneeUserId: body.assigneeUserId },
              },
              audit: {
                recordAuditEvent,
                workspaceId: existing.workspaceId,
                previousStatus: existing.status,
                metadata: { kind: existing.kind, scoutKey: existing.scoutKey },
              },
            });
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

export default assignSignal;
