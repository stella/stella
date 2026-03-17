import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const updateActiveWorkspace = createHandler(
  config,
  async ({ scopedDb, user, session, workspaceId }) => {
    await scopedDb((tx) =>
      tx
        .update(member)
        .set({ lastActiveWorkspaceId: workspaceId })
        .where(
          and(
            eq(member.userId, user.id),
            eq(member.organizationId, session.activeOrganizationId),
          ),
        ),
    );
  },
);

export default updateActiveWorkspace;
