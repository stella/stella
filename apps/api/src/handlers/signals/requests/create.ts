import { Result } from "better-result";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_SEVERITY,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import type { SignalSubject } from "@stll/api-contract/signals";

import {
  loadVisibleSignal,
  serializeSignal,
} from "@/api/handlers/signals/read";
import { createRequestBodySchema } from "@/api/handlers/signals/schema";
import { canTriageSignals } from "@/api/handlers/signals/transition";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
} from "@/api/lib/audit-log.constants";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { emitSignals } from "@/api/lib/signals/emit";

const config = {
  description:
    "Post a manual request into the inbox: a piece of work for the legal " +
    "team, optionally scoped to a matter and assigned to a colleague.",
  permissions: { signal: ["create"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  body: createRequestBodySchema,
} satisfies HandlerConfig;

const createRequest = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    body,
    getWorkspaceAccess,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;
    const requestedMatterId = body.matterId ?? null;
    let workspaceId: SafeId<"workspace"> | null = null;
    if (requestedMatterId) {
      const access = yield* Result.await(
        Result.tryPromise(
          async () => await getWorkspaceAccess(requestedMatterId),
        ),
      );
      if (!access) {
        return Result.err(
          new HandlerError({ status: 404, message: "Matter not found" }),
        );
      }
      workspaceId = access.id;
    }
    if (!workspaceId && !canTriageSignals(memberRole)) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Unscoped requests require the triage permission",
        }),
      );
    }

    const assigneeUserId = body.assigneeUserId ?? null;
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

    const subject: SignalSubject = workspaceId
      ? { type: "workspace", workspaceId }
      : { type: "none" };
    const summary = body.description.trim().slice(0, 280);

    const { insertedIds } = yield* Result.await(
      safeDb(async (tx) => {
        const emitted = await emitSignals({
          tx,
          organizationId,
          signals: [
            {
              kind: SIGNAL_KIND.REQUEST_SUBMITTED,
              scoutKey: SCOUT_KEY.MANUAL_REQUEST,
              workspaceId,
              severity: body.severity ?? SIGNAL_SEVERITY.NOTICE,
              confidence: null,
              title: body.title.trim(),
              summary,
              subject,
              evidence: {
                kind: SIGNAL_KIND.REQUEST_SUBMITTED,
                description: body.description,
                attachments: [],
              },
              suggestions: workspaceId
                ? [
                    {
                      kind: SUGGESTION_KIND.CREATE_TASK,
                      workspaceId,
                      name: body.title.trim(),
                      dueAt: null,
                    },
                    { kind: SUGGESTION_KIND.ASSIGN },
                  ]
                : [
                    { kind: SUGGESTION_KIND.PROMOTE_TO_WORKSPACE },
                    { kind: SUGGESTION_KIND.ASSIGN },
                  ],
              // Manual requests are never duplicates of each other.
              dedupeKey: `manual:${createSafeId<"signal">()}`,
              assigneeUserId,
              createdByUserId: user.id,
            },
          ],
        });
        const signalId = emitted.insertedIds.at(0);
        if (signalId) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.SIGNAL,
            resourceId: signalId,
            workspaceId,
            metadata: { kind: SIGNAL_KIND.REQUEST_SUBMITTED },
          });
        }
        return emitted;
      }),
    );

    const signalId = insertedIds.at(0);
    if (!signalId) {
      return Result.err(
        new HandlerError({ status: 500, message: "Request was not stored" }),
      );
    }
    const row = yield* yield* loadVisibleSignal({
      safeDb,
      organizationId,
      canTriage: canTriageSignals(memberRole),
      signalId,
    });
    return Result.ok(serializeSignal(row));
  },
);

export default createRequest;
