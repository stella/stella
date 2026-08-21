import { Result } from "better-result";

import { SIGNAL_STATUS, SUGGESTION_KIND } from "@stll/api-contract/signals";
import type { SignalSuggestion } from "@stll/api-contract/signals";

import type { SignalAcceptedResult } from "@/api/db/schema";
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
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AGENDA_ITEM_KIND } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";

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

    let acceptedResult: SignalAcceptedResult = {
      suggestionKind: suggestion.kind,
    };

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
        const created = yield* yield* createTaskEntityHandler({
          safeDb,
          workspaceId,
          userId: user.id,
          recordAuditEvent,
          body: {
            name: suggestion.name,
            agendaKind: isDeadline
              ? AGENDA_ITEM_KIND.DEADLINE
              : AGENDA_ITEM_KIND.TASK,
            dueDate: suggestion.dueAt ? toDateOnly(suggestion.dueAt) : null,
          },
        });
        acceptedResult = {
          suggestionKind: suggestion.kind,
          entityId: created.entityId,
          workspaceId,
        };
        break;
      }
      case SUGGESTION_KIND.FILE_TO_WORKSPACE:
      case SUGGESTION_KIND.PROMOTE_TO_WORKSPACE:
      case SUGGESTION_KIND.ASSIGN:
      case SUGGESTION_KIND.RUN_REVIEW:
      case SUGGESTION_KIND.OPEN_CHAT: {
        const reported = body.result;
        if (reported) {
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
            entityId: reported.entityId,
            workspaceId: reported.workspaceId,
          };
        }
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
