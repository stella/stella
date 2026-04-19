import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: {
    workspace: ["read"],
  },
} satisfies HandlerConfig;

const readWorkspaceNavigation = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const workspaces = yield* Result.await(
      safeDb((tx) =>
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
      ),
    );

    return Result.ok({
      workspaces,
      workspacesCountLimit: LIMITS.workspacesCount,
    });
  },
);

export default readWorkspaceNavigation;
