import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import { workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  permissions: {
    workspace: ["read"],
  },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
} satisfies HandlerConfig;

const readActiveWorkspace = createSafeRootHandler(
  config,
  async function* ({ safeDb, user, session }) {
    const result = yield* Result.await(
      safeDb(async (tx) =>
        (
          await tx
            .select({ lastActiveWorkspaceId: workspaces.id })
            .from(member)
            .leftJoin(
              workspaces,
              and(
                eq(workspaces.id, sql`${member.lastActiveWorkspaceId}::uuid`),
                eq(workspaces.organizationId, member.organizationId),
              ),
            )
            .where(
              and(
                eq(member.userId, user.id),
                eq(member.organizationId, session.activeOrganizationId),
              ),
            )
            .limit(1)
        ).at(0),
      ),
    );

    if (!result) {
      return Result.err(
        new HandlerError({ status: 404, message: "Member not found" }),
      );
    }

    return Result.ok({
      lastActiveWorkspaceId: result.lastActiveWorkspaceId,
    });
  },
);

export default readActiveWorkspace;
