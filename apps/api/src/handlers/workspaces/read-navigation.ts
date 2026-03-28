import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: {
    workspace: ["read"],
  },
} satisfies HandlerConfig;

const readWorkspaceNavigation = createRootHandler(
  config,
  async ({ scopedDb, session }) => {
    const workspaces = await scopedDb((tx) =>
      tx.query.workspaces.findMany({
        where: {
          organizationId: { eq: session.activeOrganizationId },
          status: { eq: "active" },
        },
        columns: {
          id: true,
          name: true,
          reference: true,
          clientId: true,
          color: true,
          lastActivityAt: true,
        },
        with: {
          client: {
            columns: {
              id: true,
              displayName: true,
            },
          },
        },
        orderBy: {
          lastActivityAt: "desc",
        },
        limit: LIMITS.workspacesCount,
      }),
    );

    return {
      workspaces,
      workspacesCountLimit: LIMITS.workspacesCount,
    };
  },
);

export default readWorkspaceNavigation;
