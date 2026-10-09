import { Result } from "better-result";

import { entityContextProjection } from "@/api/db/entity-feature-policies";
import { entities } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { reviewGateForTask } from "@/api/lib/flows/review-gate-task";
import {
  WORK_OBLIGATION_CONTEXT_EXTRAS,
  WORK_OBLIGATION_EVENT_CONTEXT_EXTRAS,
} from "@/api/lib/work-obligations/read-context";

const parentContext = entityContextProjection(entities.parentId);

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
    mcp: { type: "covered", by: "list_tasks" },
    access: "read",
    params: readTaskByIdParamsSchema,
  },
  async function* ({ workspaceId, params, safeDb }) {
    const task = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          columns: { parentId: false },
          extras: {
            parentId: (table) => parentContext.id(table.parentId),
            parentReference: (table) => parentContext.reference(table.parentId),
          },
          where: {
            id: { eq: params.taskId },
            workspaceId: { eq: workspaceId },
            kind: { eq: "task" },
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
              columns: { sourceEntityId: false },
              extras: WORK_OBLIGATION_CONTEXT_EXTRAS,
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
                  columns: { details: false },
                  extras: WORK_OBLIGATION_EVENT_CONTEXT_EXTRAS,
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
              where: { kind: { eq: "task" } },
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
