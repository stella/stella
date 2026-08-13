import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { detached } from "@/api/lib/detached";
import { prewarmScopedDownloadSigning } from "@/api/lib/s3-presign";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
} satisfies HandlerConfig;

const updateActiveWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, user, session, workspaceId }) {
    // Opening a workspace is the earliest signal that file presigns for it
    // are imminent; warming the scoped signing session here (detached, off
    // the response path) hides the first presign's STS AssumeRole round
    // trip, which otherwise lands on the first document open as a >1s
    // GET /files/:id/url tail.
    detached(
      prewarmScopedDownloadSigning({
        organizationId: session.activeOrganizationId,
        workspaceId,
      }),
      "workspaces.prewarm-scoped-signing",
    );

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — last-active workspace pointer is ephemeral UI
        // navigation state; not SOC 2 / ISO 27001 relevant and fires
        // frequently on every workspace switch.
        await tx
          .update(member)
          .set({ lastActiveWorkspaceId: workspaceId })
          .where(
            and(
              eq(member.userId, user.id),
              eq(member.organizationId, session.activeOrganizationId),
            ),
          );
      }),
    );

    return Result.ok({});
  },
);

export default updateActiveWorkspace;
