import { Result } from "better-result";

import {
  SIGNAL_KIND,
  SIGNAL_STATUS,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import type { SignalKind, SignalSuggestion } from "@stll/api-contract/signals";

import { abortableTx } from "@/api/db/safe-db";
import type {
  SignalAcceptedResult,
  WorkObligationSource,
} from "@/api/db/schema";
import {
  loadVisibleSignal,
  serializeSignal,
} from "@/api/handlers/signals/read";
import {
  acceptBodySchema,
  signalParamsSchema,
} from "@/api/handlers/signals/schema";
import {
  canTriageSignals,
  SIGNAL_EVENT_TYPE,
  transitionSignal,
} from "@/api/handlers/signals/transition";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { AGENDA_ITEM_KIND } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { deployedTaskFeatures } from "@/api/lib/tasks/deployment-features";

const config = {
  description:
    "Accept an inbox signal by taking one of its suggestions. Task and " +
    "deadline suggestions are created here; for the others the client " +
    "performs the action and reports what it produced.",
  permissions: { signal: ["resolve"] },
  access: "write",
  mcp: { type: "capability", reason: "workflow_orchestration" },
  params: signalParamsSchema,
  body: acceptBodySchema,
} satisfies HandlerConfig;

const toDateOnly = (iso: string): string => iso.slice(0, 10);

const SIGNAL_WORK_OBLIGATION_SOURCE = {
  [SIGNAL_KIND.REQUEST_SUBMITTED]: "manual",
  [SIGNAL_KIND.HEARING_CHANGED]: "calendar",
  [SIGNAL_KIND.DEADLINE_DETECTED]: "document",
  [SIGNAL_KIND.CONTRACT_REVIEWED]: "document",
} as const satisfies Record<SignalKind, WorkObligationSource>;

const acceptSignal = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    params,
    body,
    getWorkspaceAccess,
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

    const suggestion: SignalSuggestion | undefined = existing.suggestions.find(
      (candidate) => candidate.kind === body.suggestionKind,
    );
    if (!suggestion) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Suggestion is not offered by this signal",
        }),
      );
    }

    let acceptedResult: SignalAcceptedResult;

    switch (suggestion.kind) {
      case SUGGESTION_KIND.CREATE_TASK:
      case SUGGESTION_KIND.CREATE_DEADLINE: {
        const workspaceId = brandPersistedWorkspaceId(suggestion.workspaceId);
        const access = yield* Result.await(
          Result.tryPromise(async () => await getWorkspaceAccess(workspaceId)),
        );
        if (!access) {
          return Result.err(
            new HandlerError({ status: 404, message: "Matter not found" }),
          );
        }
        const isDeadline = suggestion.kind === SUGGESTION_KIND.CREATE_DEADLINE;
        const taskFeatures = deployedTaskFeatures();
        const entityId = createSafeId<"entity">();
        acceptedResult = {
          suggestionKind: suggestion.kind,
          result: { type: "entity", entityId, workspaceId },
        };

        const created = yield* Result.await(
          abortableTx(safeDb, async (tx) => {
            const transition = await transitionSignal({
              tx,
              organizationId,
              signalId: params.signalId,
              actorUserId: user.id,
              from: [SIGNAL_STATUS.NEW, SIGNAL_STATUS.SNOOZED],
              set: {
                status: SIGNAL_STATUS.ACCEPTED,
                acceptedResult,
                snoozedUntil: null,
                resolvedAt: new Date(),
              },
              event: {
                type: SIGNAL_EVENT_TYPE.ACCEPTED,
                payload: { ...acceptedResult },
              },
              audit: {
                recordAuditEvent,
                workspaceId: existing.workspaceId,
                previousStatus: existing.status,
                metadata: {
                  kind: existing.kind,
                  scoutKey: existing.scoutKey,
                  suggestionKind: suggestion.kind,
                },
              },
            });
            if (transition.isErr()) {
              throw transition.error;
            }

            const task = await Result.gen(() =>
              createTaskEntityHandler({
                tx,
                workspaceId,
                userId: user.id,
                recordAuditEvent,
                entityId,
                body: {
                  name: suggestion.name,
                  agendaKind: isDeadline
                    ? AGENDA_ITEM_KIND.DEADLINE
                    : AGENDA_ITEM_KIND.TASK,
                  dueDate: suggestion.dueAt
                    ? toDateOnly(suggestion.dueAt)
                    : null,
                },
                features: taskFeatures,
                ...(taskFeatures.governedWorkflow
                  ? {
                      workObligationSource: {
                        type: SIGNAL_WORK_OBLIGATION_SOURCE[existing.kind],
                        description: `Inbox signal ${existing.id}: ${existing.title}`,
                      },
                    }
                  : {}),
              }),
            );
            if (task.isErr()) {
              throw task.error;
            }
            return task.value;
          }),
        );
        flushEntitySearchRepairs([created.entityId]).catch(captureError);

        const row = yield* yield* loadVisibleSignal({
          safeDb,
          organizationId,
          canTriage,
          signalId: params.signalId,
        });
        return Result.ok(serializeSignal(row));
      }
      case SUGGESTION_KIND.PROMOTE_TO_WORKSPACE: {
        const reported = body.result;
        if (!reported) {
          return Result.err(
            new HandlerError({
              status: 400,
              message: "Matter promotion must report the created matter",
            }),
          );
        }
        const access = yield* Result.await(
          Result.tryPromise(
            async () => await getWorkspaceAccess(reported.workspaceId),
          ),
        );
        if (!access) {
          return Result.err(
            new HandlerError({ status: 404, message: "Matter not found" }),
          );
        }
        acceptedResult = {
          suggestionKind: suggestion.kind,
          result: { type: "workspace", workspaceId: reported.workspaceId },
        };
        break;
      }
      case SUGGESTION_KIND.ASSIGN:
      case SUGGESTION_KIND.OPEN_CHAT: {
        acceptedResult = {
          suggestionKind: suggestion.kind,
          result: { type: "none" },
        };
        break;
      }
      default: {
        const exhaustive: never = suggestion;
        return exhaustive;
      }
    }

    const transition = yield* Result.await(
      safeDb(async (tx) => {
        const result = await transitionSignal({
          tx,
          organizationId,
          signalId: params.signalId,
          actorUserId: user.id,
          from: [SIGNAL_STATUS.NEW, SIGNAL_STATUS.SNOOZED],
          set: {
            status: SIGNAL_STATUS.ACCEPTED,
            acceptedResult,
            snoozedUntil: null,
            resolvedAt: new Date(),
          },
          event: {
            type: SIGNAL_EVENT_TYPE.ACCEPTED,
            payload: { ...acceptedResult },
          },
          audit: {
            recordAuditEvent,
            workspaceId: existing.workspaceId,
            previousStatus: existing.status,
            metadata: {
              kind: existing.kind,
              scoutKey: existing.scoutKey,
              suggestionKind: suggestion.kind,
            },
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

export default acceptSignal;
