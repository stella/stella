import { Result } from "better-result";

import { SIGNAL_STATUS } from "@stll/api-contract/signals";

import {
  loadVisibleSignal,
  serializeSignal,
} from "@/api/handlers/signals/read";
import {
  assignBodySchema,
  signalParamsSchema,
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
    "Assign an open inbox signal to an organization member, or clear the " +
    "assignment with null.",
  permissions: { signal: ["resolve"] },
  access: "write",
  mcp: { type: "capability", reason: "workflow_orchestration" },
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
    const existing = yield* yield* loadVisibleSignal({
      safeDb,
      organizationId,
      canTriage,
      signalId: params.signalId,
    });
    const assigneeUserId = body.assigneeUserId;
    if (assigneeUserId) {
      const orgMember = yield* Result.await(
        safeDb((tx) =>
          tx.query.member.findFirst({
            where: {
              userId: { eq: assigneeUserId },
              organizationId: { eq: organizationId },
            },
            columns: { id: true },
          }),
        ),
      );
      if (!orgMember) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Assignee is not a member of this organization",
          }),
        );
      }
    }
    const transition = yield* Result.await(
      safeDb(
        async (tx) =>
          await transitionSignal({
            tx,
            organizationId,
            signalId: params.signalId,
            actorUserId: user.id,
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

export default assignSignal;
