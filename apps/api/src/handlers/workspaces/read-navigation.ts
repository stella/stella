import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const WORKSPACE_NAVIGATION_STATUS_SCOPE = {
  ACTIVE: "active",
  ACTIVE_AND_ARCHIVED: "active-and-archived",
} as const;

const config = {
  permissions: {
    workspace: ["read"],
  },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  query: t.Object({
    statusScope: t.Optional(
      t.Union([
        t.Literal(WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE),
        t.Literal(WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE_AND_ARCHIVED),
      ]),
    ),
  }),
} satisfies HandlerConfig;

const readWorkspaceNavigation = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const statusScope =
      query.statusScope ?? WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE;
    const workspaces = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaces.findMany({
          where: {
            organizationId: { eq: session.activeOrganizationId },
            status:
              statusScope === WORKSPACE_NAVIGATION_STATUS_SCOPE.ACTIVE
                ? { eq: "active" }
                : { ne: "deleting" },
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
