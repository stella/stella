import { panic, Result } from "better-result";

import {
  SIGNAL_KIND,
  SIGNAL_STATUS,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import type { SignalKind, SignalSuggestion } from "@stll/api-contract/signals";

import { abortableTx, resultTx } from "@/api/db/safe-db";
import type {
  SignalAcceptedResult,
  WorkObligationSource,
} from "@/api/db/schema";
import {
  acceptBodySchema,
  signalParamsSchema,
} from "@/api/handlers/signals/schema";
import {
  SIGNAL_EVENT_TYPE,
  transitionSignal,
} from "@/api/handlers/signals/transition";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { AGENDA_ITEM_KIND } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { withVisibleSignal } from "@/api/lib/signals/proofs/signal-visible-to";
import {
  canTriageSignals,
  loadVisibleSignal,
  serializeSignal,
} from "@/api/lib/signals/read";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { deployedTaskFeatures } from "@/api/lib/tasks/deployment-features";

const config = {
  description:
    "Accept an inbox signal by taking one of its suggestions. Task and " +
    "deadline suggestions are created here; for the others the client " +
    "performs the action and reports what it produced.",
  permissions: { signal: ["resolve"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: {
    type: "capability",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  params: signalParamsSchema,
  body: acceptBodySchema,
} satisfies HandlerConfig;

const toDateOnly = (iso: string): string => iso.slice(0, 10);

const SIGNAL_WORK_OBLIGATION_SOURCE = {
  [SIGNAL_KIND.REQUEST_SUBMITTED]: "manual",
  // Hearings come from the court registry scout, not from a calendar feed.
  [SIGNAL_KIND.HEARING_CHANGED]: "court",
  [SIGNAL_KIND.DEADLINE_DETECTED]: "document",
  [SIGNAL_KIND.CONTRACT_REVIEWED]: "document",
  // The work-attention kinds carry no task or deadline suggestion, so these
  // entries only decide provenance if one is ever added. They report on work
  // a person already created inside Stella, which is `manual`.
  [SIGNAL_KIND.WORK_UNACKNOWLEDGED]: "manual",
  [SIGNAL_KIND.WORK_DEADLINE_AT_RISK]: "manual",
} as const satisfies Record<SignalKind, WorkObligationSource>;

export type AcceptSignalDependencies = {
  flushEntitySearchRepairs: typeof flushEntitySearchRepairs;
  taskFeatures: typeof deployedTaskFeatures;
};

const DEFAULT_ACCEPT_SIGNAL_DEPENDENCIES = {
  flushEntitySearchRepairs,
  taskFeatures: deployedTaskFeatures,
} satisfies AcceptSignalDependencies;

export const createAcceptSignal = (
  dependencies: AcceptSignalDependencies = DEFAULT_ACCEPT_SIGNAL_DEPENDENCIES,
) =>
  createSafeRootHandler(
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

      const suggestion: SignalSuggestion | undefined =
        existing.suggestions.find(
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
            Result.tryPromise(
              async () => await getWorkspaceAccess(workspaceId),
            ),
          );
          if (!access) {
            return Result.err(
              new HandlerError({ status: 404, message: "Matter not found" }),
            );
          }
          const isDeadline =
            suggestion.kind === SUGGESTION_KIND.CREATE_DEADLINE;
          const taskFeatures = dependencies.taskFeatures();
          const entityId = createSafeId<"entity">();
          acceptedResult = {
            suggestionKind: suggestion.kind,
            result: { type: "entity", entityId, workspaceId },
          };

          const created = yield* Result.await(
            abortableTx(safeDb, async (transaction) => {
              const outcome = await withVisibleSignal(
                {
                  tx: transaction,
                  organizationId,
                  actorUserId: user.id,
                  memberRole,
                  signalId: params.signalId,
                  expectedUpdatedAt: existing.updatedAt,
                },
                async ({
                  tx,
                  signal,
                  actor,
                  proof,
                  existing: checkedSignal,
                }) => {
                  const transition = await transitionSignal({
                    tx,
                    visibility: proof,
                    signalId: signal,
                    actorUserId: actor,
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
                      workspaceId: checkedSignal.workspaceId,
                      previousStatus: checkedSignal.status,
                      metadata: {
                        kind: checkedSignal.kind,
                        scoutKey: checkedSignal.scoutKey,
                        suggestionKind: suggestion.kind,
                      },
                    },
                  });
                  if (transition.isErr()) {
                    return Result.err(transition.error);
                  }

                  const task = await Result.gen(() =>
                    createTaskEntityHandler({
                      tx: tx.value,
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
                              type: SIGNAL_WORK_OBLIGATION_SOURCE[
                                checkedSignal.kind
                              ],
                              description: `Inbox signal ${checkedSignal.id}: ${checkedSignal.title}`,
                              ...(checkedSignal.subject.type === "entity"
                                ? {
                                    entityId: brandPersistedEntityId(
                                      checkedSignal.subject.entityId,
                                    ),
                                  }
                                : {}),
                            },
                          }
                        : {}),
                    }),
                  );
                  return task;
                },
              );
              if (outcome.isErr()) {
                throw outcome.error;
              }
              return outcome.value;
            }),
          );
          dependencies
            .flushEntitySearchRepairs([created.entityId])
            .catch(captureError);

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
          suggestion satisfies never;
          return panic(`Unhandled suggestion: ${String(suggestion)}`);
        }
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
              expectedUpdatedAt: existing.updatedAt,
            },
            async ({ tx, signal, actor, proof, existing: checkedSignal }) => {
              const result = await transitionSignal({
                tx,
                visibility: proof,
                signalId: signal,
                actorUserId: actor,
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
                  workspaceId: checkedSignal.workspaceId,
                  previousStatus: checkedSignal.status,
                  metadata: {
                    kind: checkedSignal.kind,
                    scoutKey: checkedSignal.scoutKey,
                    suggestionKind: suggestion.kind,
                  },
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

const acceptSignal = createAcceptSignal();

export default acceptSignal;
