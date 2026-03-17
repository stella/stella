import { status } from "elysia";

import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: {
    workspace: ["read"],
  },
} satisfies HandlerConfig;

const readActiveWorkspace = createRootHandler(
  config,
  async ({ scopedDb, user, session }) => {
    const result = await scopedDb((tx) =>
      tx.query.member.findFirst({
        where: {
          userId: user.id,
          organizationId: { eq: session.activeOrganizationId },
        },
        columns: {
          lastActiveWorkspaceId: true,
        },
      }),
    );

    if (!result) {
      return status(404);
    }

    return {
      lastActiveWorkspaceId: result.lastActiveWorkspaceId,
    };
  },
);

export default readActiveWorkspace;
