import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadTaskByIdProps = {
  workspaceId: SafeId<"workspace">;
  taskId: string;
  scopedDb: ScopedDb;
};

export const readTaskByIdHandler = async ({
  workspaceId,
  taskId,
  scopedDb,
}: ReadTaskByIdProps) => {
  const task = await scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: taskId,
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

  return task ?? null;
};
