import { status, t } from "elysia";

import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const readTaskByIdParamsSchema = t.Object({
  taskId: tNanoid,
});

const readTaskById = createHandler(
  {
    permissions: { workspace: ["read"] },
    params: readTaskByIdParamsSchema,
  },
  async ({ workspaceId, params, scopedDb }) => {
    const task = await scopedDb((tx) =>
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
    );

    if (!task) {
      return status(404, { message: "Task not found" });
    }

    return task;
  },
);

export default readTaskById;
