import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const updateActiveWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, user, session, workspaceId }) {
    yield* Result.await(
      safeDb((tx) =>
        tx
          .update(member)
          .set({ lastActiveWorkspaceId: workspaceId })
          .where(
            and(
              eq(member.userId, user.id),
              eq(member.organizationId, session.activeOrganizationId),
            ),
          ),
      ),
    );

    return Result.ok(undefined);
  },
);

export default updateActiveWorkspace;
