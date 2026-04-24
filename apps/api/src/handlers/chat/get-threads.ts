import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { chat: ["create"] },
} satisfies HandlerConfig;

const getThreads = createSafeRootHandler(
  config,
  async function* ({ accessibleWorkspaces, safeDb, user }) {
    const deletingWorkspaceIds = new Set(
      accessibleWorkspaces
        .filter((w) => w.status === "deleting")
        .map((w) => w.id),
    );

    const rows = yield* Result.await(
      safeDb((tx) =>
        tx.query.chatThreads.findMany({
          where: {
            userId: { eq: user.id },
          },
          columns: {
            id: true,
            title: true,
            createdAt: true,
            updatedAt: true,
            workspaceId: true,
          },
          with: {
            workspace: {
              columns: {
                id: true,
                name: true,
              },
            },
          },
          orderBy: { updatedAt: "desc" },
        }),
      ),
    );

    const global: {
      id: string;
      title: string;
      createdAt: Date;
      updatedAt: Date;
    }[] = [];

    const groupedWorkspaceThreads = new Map<
      string,
      {
        workspaceId: string;
        workspaceName: string;
        threads: {
          id: string;
          title: string;
          createdAt: Date;
          updatedAt: Date;
        }[];
      }
    >();

    for (const thread of rows) {
      // Skip threads from workspaces being deleted so users
      // don't see entries they can't open or manage.
      if (
        thread.workspaceId !== null &&
        deletingWorkspaceIds.has(thread.workspaceId)
      ) {
        continue;
      }

      if (thread.workspaceId === null) {
        global.push({
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        });
        continue;
      }

      if (!thread.workspace) {
        continue;
      }

      const slice = {
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      };

      const existingGroup = groupedWorkspaceThreads.get(thread.workspaceId);
      if (existingGroup) {
        existingGroup.threads.push(slice);
        continue;
      }

      groupedWorkspaceThreads.set(thread.workspaceId, {
        workspaceId: thread.workspaceId,
        workspaceName: thread.workspace.name,
        threads: [slice],
      });
    }

    const workspaces = Array.from(groupedWorkspaceThreads.values()).sort(
      (left, right) => {
        const leftUpdatedAt = left.threads.at(0)?.updatedAt.getTime() ?? 0;
        const rightUpdatedAt = right.threads.at(0)?.updatedAt.getTime() ?? 0;

        return rightUpdatedAt - leftUpdatedAt;
      },
    );

    return Result.ok({
      global,
      workspaces,
    });
  },
);

export default getThreads;
