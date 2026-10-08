import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FLOW_TASK_FEATURE_ACCESS,
  admitTaskFlowAccess,
  reviewGateForTask,
} from "@/api/lib/flows/review-gate-task";
import { flowRelatedTaskVisibilityConditions } from "@/api/lib/flows/visibility";

const readTaskByIdParamsSchema = workspaceParams({ taskId: tSafeId("entity") });

const readTaskById = createSafeHandler(
  {
    description:
      "Read one task in full: its own fields, its assignees with their " +
      "users, its governed-work ownership with the most recent lifecycle " +
      "events, its child tasks with their assignees, its links in both " +
      "directions, and who created it.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: FLOW_TASK_FEATURE_ACCESS,
    mcp: { type: "covered", by: "list_tasks" },
    access: "read",
    params: readTaskByIdParamsSchema,
  },
  async function* ({ workspaceId, params, safeDb, user, session }) {
    const admission = yield* Result.await(
      safeDb(
        async (tx) =>
          await admitTaskFlowAccess(tx, {
            access: "read",
            workspaceId,
            taskEntityId: params.taskId,
            userId: user.id,
          }),
      ),
    );
    yield* admission;
    const visibility = flowRelatedTaskVisibilityConditions({
      organizationId: session.activeOrganizationId,
      userId: user.id,
    });
    const task = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: params.taskId },
            workspaceId: { eq: workspaceId },
            kind: { eq: "task" },
            RAW: visibility.entity,
          },
          with: {
            assignees: {
              with: {
                user: {
                  columns: {
                    id: true,
                    name: true,
                    image: true,
                    deletedAt: true,
                  },
                },
              },
            },
            workObligation: {
              with: {
                owner: {
                  columns: {
                    id: true,
                    name: true,
                    image: true,
                    deletedAt: true,
                  },
                },
                acknowledgedBy: {
                  columns: {
                    id: true,
                    name: true,
                    image: true,
                    deletedAt: true,
                  },
                },
                events: {
                  orderBy: { occurredAt: "desc", id: "desc" },
                  limit: 100,
                  with: {
                    actor: {
                      columns: {
                        id: true,
                        name: true,
                        image: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
              },
            },
            children: {
              where: {
                kind: { eq: "task" },
                RAW: visibility.entity,
              },
              columns: {
                id: true,
                name: true,
                status: true,
                priority: true,
                dueDate: true,
                listItemType: true,
                agendaKind: true,
                startAt: true,
                endAt: true,
                occurredAt: true,
                remindAt: true,
                allDay: true,
                timeZone: true,
                location: true,
                onlineMeetingUrl: true,
                availability: true,
                sensitivity: true,
                organizer: true,
                attendees: true,
                recurrence: true,
                agendaSource: true,
                externalSource: true,
                externalId: true,
                externalChangeKey: true,
                externalICalUid: true,
                readOnly: true,
                sortOrder: true,
                createdAt: true,
              },
              with: {
                assignees: {
                  with: {
                    user: {
                      columns: {
                        id: true,
                        name: true,
                        image: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
              },
            },
            linksAsSource: {
              where: { RAW: visibility.link },
              with: {
                targetEntity: {
                  columns: {
                    id: true,
                    name: true,
                    kind: true,
                  },
                },
              },
            },
            linksAsTarget: {
              where: { RAW: visibility.link },
              with: {
                sourceEntity: {
                  columns: {
                    id: true,
                    name: true,
                    kind: true,
                  },
                },
              },
            },
            currentVersion: true,
            createdByUser: {
              columns: {
                id: true,
                name: true,
                image: true,
                deletedAt: true,
              },
            },
          },
        }),
      ),
    );

    if (!task) {
      return Result.err(
        new HandlerError({ status: 404, message: "Task not found" }),
      );
    }

    // The task a workflow review gate raised opens onto its run: the gate's
    // instructions and the AI output under review live there, not here.
    const gate = yield* Result.await(
      safeDb(
        async (tx) =>
          await reviewGateForTask(tx, {
            workspaceId,
            taskEntityId: params.taskId,
          }),
      ),
    );
    const gateRunId = gate?.runId ?? null;

    return Result.ok({
      ...task,
      flowReview: gateRunId === null ? null : { runId: gateRunId },
    });
  },
);

export default readTaskById;
