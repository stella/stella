import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readTaskByIdParamsSchema = t.Object({
  taskId: tNanoid,
});

const readTaskById = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    params: readTaskByIdParamsSchema,
  },
  async function* ({ workspaceId, params, safeDb }) {
    const task = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: params.taskId,
            workspaceId: { eq: workspaceId },
            kind: "task",
          },
          with: {
            assignees: {
              with: {
                user: {
                  columns: {
                    id: true,
                    name: true,
                    image: true,
                  },
                },
              },
            },
            children: {
              where: { kind: "task" },
              columns: {
                id: true,
                name: true,
                status: true,
                priority: true,
                dueDate: true,
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

    return Result.ok(task);
  },
);

export default readTaskById;
